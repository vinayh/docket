import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { DocRegion } from "../db/schema.ts";

/**
 * OOXML (`.docx`) parser. The ingest entry point — see SPEC §9.8 for why
 * this is the canonical inbound source and not Drive `comments.list` /
 * `documents.get`. Output is consumed by `src/domain/comments.ts`; this
 * module does no DB work.
 *
 * Endpoint-shaped: a single function `parseDocx(bytes) → DocxAnnotations`.
 * No tokens, no fetches. Pair with `exportDocx` in `./drive.ts` for the
 * fetch half.
 */

export type DocxSuggestionKind = "suggestion_insert" | "suggestion_delete";

/**
 * One annotation range, anchored to (region, paragraphIndex, runOffset).
 * `runOffset` is a character offset *within the paragraph's plaintext*
 * (excluding the trailing newline), computed by summing every `<w:r><w:t>`
 * length up to the marker, matching how the rest of Margin's anchor model
 * already addresses positions (SPEC §4, anchor.structuralPosition.offset).
 */
export interface DocxRange {
  region: DocRegion;
  /** Header/footer/footnote id; empty string for body. */
  regionId: string;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  /** Paragraph plaintext for each paragraph the range covers, in order. */
  paragraphTexts: string[];
}

export interface DocxComment {
  /** `w:id` on the `<w:comment>` element. Stable within one export. */
  id: string;
  /** Display name from `w:author`. OOXML drops email entirely (SPEC §9.8). */
  author: string;
  /** `w:date` as the raw ISO-8601 string. */
  date: string;
  /** Plain-text body — `<w:t>` content inside `<w:comment>`, with paragraph breaks joined by `\n`. */
  body: string;
  /**
   * One or more ranges. >1 when the same (author, date, body) appears as
   * multiple OOXML `<w:comment>` rows — Google exports a disjoint
   * multi-range comment as N rows sharing those three fields (SPEC §9.8).
   * `ranges[0]` is the primary anchor used by the canonical store.
   */
  ranges: DocxRange[];
  /**
   * When this comment's range overlaps a `<w:ins>` or `<w:del>` span,
   * the suggestion's id. Per SPEC §9.8 reply-on-suggestion detection,
   * such a comment is a reply on that suggestion's thread.
   */
  overlapsSuggestionId?: string;
}

export interface DocxSuggestion {
  /** `w:id` on the `<w:ins>` / `<w:del>` element. */
  id: string;
  kind: DocxSuggestionKind;
  /** Author display name from `w:author`. */
  author: string;
  /** `w:date` as raw ISO-8601. */
  date: string;
  region: DocRegion;
  regionId: string;
  paragraphIndex: number;
  paragraphText: string;
  offset: number;
  length: number;
  /** The text the suggestion adds (insert) or proposes to remove (delete). */
  text: string;
}

export interface DocxAnnotations {
  comments: DocxComment[];
  suggestions: DocxSuggestion[];
}

const COMMENT_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

void COMMENT_MIME; // referenced only for grep traceability from drive.ts

/**
 * Top-level entry. Unzips, parses each part we care about, then merges
 * comment metadata (from `word/comments.xml`) with anchor positions (from
 * `<w:commentRangeStart>`/`End` in `word/document.xml` + headers / footers /
 * footnotes). Disjoint multi-range comments are grouped by
 * `(author, date, body)` per SPEC §9.8.
 */
export function parseDocx(bytes: Uint8Array): DocxAnnotations {
  const entries = unzipSync(bytes);
  const docXml = readEntry(entries, "word/document.xml");
  if (!docXml) {
    // A doc with no body part isn't a docx — treat as empty rather than throwing,
    // so a malformed export doesn't poison the polling loop.
    return { comments: [], suggestions: [] };
  }

  const docTree = parseXml(docXml);
  const commentMeta = parseCommentsXml(readEntry(entries, "word/comments.xml"));

  const collector = new AnchorCollector();
  // Body is required; header/footer/footnote parts are optional.
  collector.walkRegion("body", "", docTree, "w:document", "w:body");
  walkAuxiliary(entries, "word/header", "header", collector);
  walkAuxiliary(entries, "word/footer", "footer", collector);
  walkAuxiliary(entries, "word/footnotes.xml", "footnote", collector);
  walkAuxiliary(entries, "word/endnotes.xml", "footnote", collector);

  const comments = assembleComments(commentMeta, collector);
  return { comments, suggestions: collector.suggestions };
}

// ──────────────────────────────────────────────────────────────────────────
// XML scaffolding
// ──────────────────────────────────────────────────────────────────────────

type XmlNode = {
  [tag: string]: XmlNode[] | string;
} & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  // Disable entity / DTD handling — `.docx` doesn't use them and disabling
  // narrows the parser's attack surface for malicious uploads.
  processEntities: true,
  parseTagValue: false,
});

function parseXml(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[];
}

function readEntry(entries: Record<string, Uint8Array>, path: string): string | null {
  const bytes = entries[path];
  return bytes ? strFromU8(bytes) : null;
}

/** Find the *first* descendant by tag name (depth-first, document order). */
function firstChild(nodes: XmlNode[], tag: string): XmlNode[] | null {
  for (const n of nodes) {
    if (tag in n && Array.isArray(n[tag])) return n[tag] as XmlNode[];
  }
  return null;
}

function tagOf(n: XmlNode): string | null {
  for (const k of Object.keys(n)) {
    if (k !== ":@" && k !== "#text") return k;
  }
  return null;
}

function attrsOf(n: XmlNode): Record<string, string> {
  return n[":@"] ?? {};
}

function childrenOf(n: XmlNode): XmlNode[] {
  const t = tagOf(n);
  if (!t) return [];
  const c = n[t];
  return Array.isArray(c) ? c : [];
}

/** Walk every `<w:p>` paragraph under a given subtree (e.g. `<w:body>`). */
function* paragraphsOf(nodes: XmlNode[]): Generator<XmlNode> {
  for (const n of nodes) {
    const t = tagOf(n);
    if (!t) continue;
    if (t === "w:p") {
      yield n;
    } else {
      yield* paragraphsOf(childrenOf(n));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Anchor walk
// ──────────────────────────────────────────────────────────────────────────

interface OpenComment {
  id: string;
  startParagraphIndex: number;
  startOffset: number;
  startRegion: DocRegion;
  startRegionId: string;
  paragraphTexts: string[];
  /**
   * Suggestion ids the comment's range has intersected so far. First match
   * wins for `overlapsSuggestionId` per SPEC §9.8 reply-on-suggestion rule.
   */
  overlapsSuggestionId?: string;
}

interface CompletedRange extends DocxRange {
  commentId: string;
  overlapsSuggestionId?: string;
}

class AnchorCollector {
  readonly ranges: CompletedRange[] = [];
  readonly suggestions: DocxSuggestion[] = [];

  private open = new Map<string, OpenComment>();

  walkRegion(
    region: DocRegion,
    regionId: string,
    tree: XmlNode[],
    ...path: string[]
  ): void {
    let cursor: XmlNode[] | null = tree;
    for (const seg of path) {
      if (!cursor) return;
      cursor = firstChild(cursor, seg);
    }
    if (!cursor) return;

    let paragraphIndex = -1;
    for (const p of paragraphsOf(cursor)) {
      paragraphIndex++;
      this.walkParagraph(region, regionId, paragraphIndex, p);
    }

    // A range left open at the end of a region is malformed but Word
    // tolerates it. Close at the last paragraph's end so we don't leak
    // state into the next region.
    for (const oc of [...this.open.values()]) {
      const last = oc.paragraphTexts[oc.paragraphTexts.length - 1] ?? "";
      this.completeRange(oc, paragraphIndex, last.length);
    }
    this.open.clear();
  }

  private walkParagraph(
    region: DocRegion,
    regionId: string,
    paragraphIndex: number,
    paragraph: XmlNode,
  ): void {
    // First pass: compute the full plaintext of this paragraph so every range
    // that touches it records the whole line (anchor.paragraphHash depends on
    // the complete paragraph, not the slice up to the marker).
    const paragraphText = paragraphPlaintext(paragraph);

    // Every currently-open comment grows a new paragraph entry the moment we
    // cross a paragraph boundary. The first paragraph for a freshly-opened
    // range is pushed at open time below.
    for (const oc of this.open.values()) oc.paragraphTexts.push(paragraphText);

    // Second pass: walk in document order to emit cursor-tracked events.
    let cursor = 0;
    for (const child of childrenOf(paragraph)) {
      const tag = tagOf(child);
      if (!tag) continue;
      const attrs = attrsOf(child);

      if (tag === "w:commentRangeStart") {
        const id = attrs["@_w:id"] ?? "";
        if (!id) continue;
        this.open.set(id, {
          id,
          startParagraphIndex: paragraphIndex,
          startOffset: cursor,
          startRegion: region,
          startRegionId: regionId,
          paragraphTexts: [paragraphText],
          overlapsSuggestionId: undefined,
        });
        continue;
      }

      if (tag === "w:commentRangeEnd") {
        const id = attrs["@_w:id"] ?? "";
        const oc = this.open.get(id);
        if (!oc) continue;
        this.completeRange(oc, paragraphIndex, cursor);
        this.open.delete(id);
        continue;
      }

      if (tag === "w:ins" || tag === "w:del") {
        const id = attrs["@_w:id"] ?? "";
        const author = attrs["@_w:author"] ?? "";
        const date = attrs["@_w:date"] ?? "";
        if (!id) continue;
        const text = this.consumeSuggestionText(child, tag);
        if (text) {
          this.suggestions.push({
            id,
            kind: tag === "w:ins" ? "suggestion_insert" : "suggestion_delete",
            author,
            date,
            region,
            regionId,
            paragraphIndex,
            paragraphText,
            offset: cursor,
            length: text.length,
            text,
          });
          // Mark any currently-open comments as overlapping this suggestion.
          for (const oc of this.open.values()) {
            if (!oc.overlapsSuggestionId) oc.overlapsSuggestionId = id;
          }
          // Inserts and deletes both contribute to the cursor; the deletion
          // text is still in the document body (struck through) so offsets
          // stay stable whether the suggestion is later accepted or rejected.
          cursor += text.length;
        }
        continue;
      }

      if (tag === "w:r") {
        cursor += collectRunText(child).length;
        continue;
      }

      // Containers (`<w:hyperlink>`, `<w:sdtContent>`) hide runs / markers
      // inside another element. Recurse so commentRange markers nested under
      // a hyperlink still land.
      if (tag === "w:hyperlink" || tag === "w:sdt" || tag === "w:sdtContent") {
        cursor = this.walkContainer(
          child,
          region,
          regionId,
          paragraphIndex,
          cursor,
          paragraphText,
        );
        continue;
      }
    }
  }

  /** Recurse into a container element (`<w:hyperlink>`, `<w:sdtContent>`). */
  private walkContainer(
    container: XmlNode,
    region: DocRegion,
    regionId: string,
    paragraphIndex: number,
    cursor: number,
    paragraphText: string,
  ): number {
    for (const child of childrenOf(container)) {
      const tag = tagOf(child);
      if (!tag) continue;
      if (tag === "w:r") {
        cursor += collectRunText(child).length;
      } else if (tag === "w:commentRangeStart" || tag === "w:commentRangeEnd") {
        const attrs = attrsOf(child);
        const id = attrs["@_w:id"] ?? "";
        if (!id) continue;
        if (tag === "w:commentRangeStart") {
          this.open.set(id, {
            id,
            startParagraphIndex: paragraphIndex,
            startOffset: cursor,
            startRegion: region,
            startRegionId: regionId,
            paragraphTexts: [paragraphText],
            overlapsSuggestionId: undefined,
          });
        } else {
          const oc = this.open.get(id);
          if (oc) {
            this.completeRange(oc, paragraphIndex, cursor);
            this.open.delete(id);
          }
        }
      }
    }
    return cursor;
  }

  private consumeSuggestionText(
    insOrDel: XmlNode,
    tag: "w:ins" | "w:del",
  ): string {
    let text = "";
    for (const child of childrenOf(insOrDel)) {
      const ct = tagOf(child);
      if (!ct) continue;
      if (ct === "w:r") {
        text += tag === "w:del" ? collectDelText(child) : collectRunText(child);
      }
    }
    return text;
  }

  private completeRange(
    oc: OpenComment,
    endParagraphIndex: number,
    endOffset: number,
  ): void {
    this.ranges.push({
      commentId: oc.id,
      region: oc.startRegion,
      regionId: oc.startRegionId,
      startParagraphIndex: oc.startParagraphIndex,
      startOffset: oc.startOffset,
      endParagraphIndex,
      endOffset,
      paragraphTexts: oc.paragraphTexts.slice(),
      overlapsSuggestionId: oc.overlapsSuggestionId,
    });
  }
}

/**
 * Concatenate every visible character contributed by a `<w:p>`'s children
 * (runs, inserted/deleted suggestion text, hyperlink/sdt-wrapped runs). The
 * trailing implicit paragraph break is not included — paragraphs are
 * delimited by index, not embedded `\n`.
 */
function paragraphPlaintext(paragraph: XmlNode): string {
  let out = "";
  for (const child of childrenOf(paragraph)) {
    const tag = tagOf(child);
    if (!tag) continue;
    if (tag === "w:r") {
      out += collectRunText(child);
    } else if (tag === "w:ins") {
      for (const sub of childrenOf(child)) {
        if (tagOf(sub) === "w:r") out += collectRunText(sub);
      }
    } else if (tag === "w:del") {
      for (const sub of childrenOf(child)) {
        if (tagOf(sub) === "w:r") out += collectDelText(sub);
      }
    } else if (tag === "w:hyperlink" || tag === "w:sdt" || tag === "w:sdtContent") {
      // Recurse into containers that wrap runs.
      out += paragraphPlaintext(child);
    }
  }
  return out;
}

function collectRunText(run: XmlNode): string {
  let out = "";
  for (const child of childrenOf(run)) {
    const t = tagOf(child);
    if (!t) continue;
    if (t === "w:t") out += textOf(child);
    else if (t === "w:tab") out += "\t";
    else if (t === "w:br" || t === "w:cr") out += "\n";
  }
  return out;
}

function collectDelText(run: XmlNode): string {
  // `<w:r>` inside `<w:del>` uses `<w:delText>` instead of `<w:t>`.
  let out = "";
  for (const child of childrenOf(run)) {
    const t = tagOf(child);
    if (!t) continue;
    if (t === "w:delText" || t === "w:t") out += textOf(child);
    else if (t === "w:tab") out += "\t";
    else if (t === "w:br" || t === "w:cr") out += "\n";
  }
  return out;
}

function textOf(el: XmlNode): string {
  const kids = childrenOf(el);
  let out = "";
  for (const k of kids) {
    const text = k["#text"];
    if (typeof text === "string") out += text;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// comments.xml parse
// ──────────────────────────────────────────────────────────────────────────

interface CommentMeta {
  id: string;
  author: string;
  date: string;
  body: string;
}

function parseCommentsXml(xml: string | null): Map<string, CommentMeta> {
  const out = new Map<string, CommentMeta>();
  if (!xml) return out;
  const tree = parseXml(xml);
  const wcomments = firstChild(tree, "w:comments");
  if (!wcomments) return out;
  for (const n of wcomments) {
    const t = tagOf(n);
    if (t !== "w:comment") continue;
    const attrs = attrsOf(n);
    const id = attrs["@_w:id"] ?? "";
    if (!id) continue;
    const author = attrs["@_w:author"] ?? "";
    const date = attrs["@_w:date"] ?? "";
    out.set(id, {
      id,
      author,
      date,
      body: collectCommentBody(n),
    });
  }
  return out;
}

/** Concatenate every `<w:p>/<w:r>/<w:t>` under a `<w:comment>`, joining paragraphs with `\n`. */
function collectCommentBody(c: XmlNode): string {
  const paragraphs: string[] = [];
  for (const p of paragraphsOf(childrenOf(c))) {
    let text = "";
    for (const child of childrenOf(p)) {
      if (tagOf(child) === "w:r") text += collectRunText(child);
    }
    paragraphs.push(text);
  }
  return paragraphs.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Aux regions
// ──────────────────────────────────────────────────────────────────────────

function walkAuxiliary(
  entries: Record<string, Uint8Array>,
  prefix: string,
  region: DocRegion,
  collector: AnchorCollector,
): void {
  // Headers/footers are numbered (header1.xml, header2.xml, …);
  // footnotes/endnotes are single files. Either form fits this glob.
  // The `.xml.rels` exclusion is enforced by the `!p.includes(".rels")`
  // guard; the prefix + `.xml` suffix check is enough on its own.
  const paths = Object.keys(entries)
    .filter((p) => p.startsWith(prefix) && p.endsWith(".xml") && !p.includes(".rels"))
    .sort();
  for (const path of paths) {
    if (!path.endsWith(".xml")) continue;
    const xml = strFromU8(entries[path]!);
    const tree = parseXml(xml);
    const regionId = regionIdFor(region, path);
    if (region === "footnote") {
      // <w:footnotes> contains many <w:footnote w:id="…">; emit one region per.
      const wrap = firstChild(tree, region === "footnote" ? "w:footnotes" : "w:endnotes");
      if (!wrap) continue;
      for (const node of wrap) {
        const t = tagOf(node);
        if (t !== "w:footnote" && t !== "w:endnote") continue;
        const id = attrsOf(node)["@_w:id"] ?? "";
        // Skip Word's built-in separator footnotes (-1, 0) which have no
        // user content and would inflate paragraph indices.
        if (id === "-1" || id === "0") continue;
        collector.walkRegion(region, id, [node], t);
      }
    } else {
      const top = region === "header" ? "w:hdr" : "w:ftr";
      collector.walkRegion(region, regionId, tree, top);
    }
  }
}

function regionIdFor(region: DocRegion, path: string): string {
  if (region === "header" || region === "footer") {
    // Use the file basename ("header1") as the regionId — it's stable across
    // ingests of the same export and matches how the relationship file maps
    // header/footer references.
    const base = path.replace(/^.*\//, "").replace(/\.xml$/, "");
    return base;
  }
  return "";
}

// ──────────────────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────────────────

function assembleComments(
  meta: Map<string, CommentMeta>,
  collector: AnchorCollector,
): DocxComment[] {
  // Group ranges by commentId so disjoint-range comments collapse into one
  // canonical DocxComment with multiple ranges (SPEC §9.8).
  const byId = new Map<string, CompletedRange[]>();
  for (const r of collector.ranges) {
    const list = byId.get(r.commentId) ?? [];
    list.push(r);
    byId.set(r.commentId, list);
  }

  // Also group by (author, date, body) — Google's export of a disjoint
  // multi-range comment creates N `<w:comment>` rows sharing those fields.
  // We collapse them post-hoc.
  type GroupKey = string;
  const groupKey = (m: CommentMeta): GroupKey => `${m.author}${m.date}${m.body}`;

  const groups = new Map<GroupKey, { meta: CommentMeta; ranges: CompletedRange[] }>();
  for (const [id, m] of meta) {
    const k = groupKey(m);
    const existing = groups.get(k);
    const ranges = byId.get(id) ?? [];
    if (existing) {
      existing.ranges.push(...ranges);
    } else {
      groups.set(k, { meta: m, ranges });
    }
  }

  const out: DocxComment[] = [];
  for (const { meta: m, ranges } of groups.values()) {
    if (ranges.length === 0) continue; // metadata with no anchor — orphan, skip
    const overlap = ranges.find((r) => r.overlapsSuggestionId)?.overlapsSuggestionId;
    out.push({
      id: m.id,
      author: m.author,
      date: m.date,
      body: m.body,
      ranges: ranges.map(stripRange),
      overlapsSuggestionId: overlap,
    });
  }
  // Stable order: earliest range first.
  out.sort((a, b) => compareRanges(a.ranges[0]!, b.ranges[0]!));
  return out;
}

function stripRange(r: CompletedRange): DocxRange {
  return {
    region: r.region,
    regionId: r.regionId,
    startParagraphIndex: r.startParagraphIndex,
    startOffset: r.startOffset,
    endParagraphIndex: r.endParagraphIndex,
    endOffset: r.endOffset,
    paragraphTexts: r.paragraphTexts,
  };
}

function compareRanges(a: DocxRange, b: DocxRange): number {
  if (a.region !== b.region) return a.region < b.region ? -1 : 1;
  if (a.regionId !== b.regionId) return a.regionId < b.regionId ? -1 : 1;
  if (a.startParagraphIndex !== b.startParagraphIndex) return a.startParagraphIndex - b.startParagraphIndex;
  return a.startOffset - b.startOffset;
}
