import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { DocRegion } from "../db/schema.ts";

// OOXML (.docx) parser. Pure: bytes in, DocxAnnotations out. See SPEC §9.8.

export type DocxSuggestionKind = "suggestion_insert" | "suggestion_delete";

// runOffset is a character offset within the paragraph's plaintext (excluding newline).
export interface DocxRange {
  region: DocRegion;
  /** Header/footer/footnote id; empty string for body. */
  regionId: string;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  paragraphTexts: string[];
}

export interface DocxComment {
  id: string;
  author: string;
  date: string;
  body: string;
  // >1 range when Google exports a disjoint multi-range comment as multiple rows.
  ranges: DocxRange[];
  // Set when the comment's range overlaps a <w:ins>/<w:del>; treats it as a suggestion reply.
  overlapsSuggestionId?: string;
}

export interface DocxSuggestion {
  id: string;
  kind: DocxSuggestionKind;
  author: string;
  date: string;
  region: DocRegion;
  regionId: string;
  paragraphIndex: number;
  paragraphText: string;
  offset: number;
  length: number;
  text: string;
}

export interface DocxAnnotations {
  comments: DocxComment[];
  suggestions: DocxSuggestion[];
}

export function parseDocx(bytes: Uint8Array): DocxAnnotations {
  const entries = unzipSync(bytes);
  const docXml = readEntry(entries, "word/document.xml");
  if (!docXml) {
    // Malformed export: return empty so the polling loop doesn't trip on it.
    return { comments: [], suggestions: [] };
  }

  const docTree = parseXml(docXml);
  const commentMeta = parseCommentsXml(readEntry(entries, "word/comments.xml"));

  const collector = new AnchorCollector();
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
  // First overlapping suggestion id wins.
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

    // Close any range still open at end-of-region so state doesn't leak across regions.
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
    // Anchors hash the full paragraph, so compute it once up front.
    const paragraphText = paragraphPlaintext(paragraph);

    // Open ranges record one paragraphTexts entry per paragraph they cross.
    for (const oc of this.open.values()) oc.paragraphTexts.push(paragraphText);

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
          for (const oc of this.open.values()) {
            if (!oc.overlapsSuggestionId) oc.overlapsSuggestionId = id;
          }
          // Both insert and delete text live in the body, so both advance the cursor.
          cursor += text.length;
        }
        continue;
      }

      if (tag === "w:r") {
        cursor += collectRunText(child).length;
        continue;
      }

      // Containers can wrap runs and commentRange markers; recurse to catch them.
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
  // Runs inside <w:del> use <w:delText> instead of <w:t>.
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
  const paths = Object.keys(entries)
    .filter((p) => p.startsWith(prefix) && p.endsWith(".xml") && !p.includes(".rels"))
    .sort();
  for (const path of paths) {
    if (!path.endsWith(".xml")) continue;
    const xml = strFromU8(entries[path]!);
    const tree = parseXml(xml);
    const regionId = regionIdFor(region, path);
    if (region === "footnote") {
      const wrap = firstChild(tree, region === "footnote" ? "w:footnotes" : "w:endnotes");
      if (!wrap) continue;
      for (const node of wrap) {
        const t = tagOf(node);
        if (t !== "w:footnote" && t !== "w:endnote") continue;
        const id = attrsOf(node)["@_w:id"] ?? "";
        // Skip Word's separator footnotes (-1, 0) — no user content.
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
    return path.replace(/^.*\//, "").replace(/\.xml$/, "");
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
  const byId = new Map<string, CompletedRange[]>();
  for (const r of collector.ranges) {
    const list = byId.get(r.commentId) ?? [];
    list.push(r);
    byId.set(r.commentId, list);
  }

  // Google exports a disjoint multi-range comment as N rows sharing (author, date, body); collapse them.
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
    if (ranges.length === 0) continue; // orphan: metadata with no anchor
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
