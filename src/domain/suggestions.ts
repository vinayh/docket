import type { Document, StructuralElement } from "../google/docs.ts";
import type { DocRegion } from "../db/schema.ts";

export type SuggestionKind = "suggestion_insert" | "suggestion_delete";

export interface SuggestionSpan {
  /** Google's suggestion ID — stable across `documents.get` calls. */
  id: string;
  kind: SuggestionKind;
  /** Region of the doc this suggestion lives in. */
  region: DocRegion;
  /** Header/footer/footnote ID. Empty string for body. */
  regionId: string;
  /** Zero-based paragraph index *within* the region. */
  paragraphIndex: number;
  /** Plain text of the containing paragraph (newline stripped). */
  paragraphText: string;
  /** Character offset of the suggested span within paragraphText. */
  offset: number;
  /** Length of the suggested span. */
  length: number;
  /** The text the suggestion adds (insertion) or proposes to remove (deletion). */
  text: string;
}

/**
 * Walk every region of the document body — main body, headers, footers, footnotes —
 * and emit one SuggestionSpan per unique suggestion ID per paragraph.
 *
 * Google models tracked changes as flags on individual TextRuns:
 *   - suggestedInsertionIds:[id] on a TextRun whose `content` is the proposed inserted text
 *   - suggestedDeletionIds:[id] on a TextRun whose `content` is the text proposed for removal
 *
 * Long suggestions split across formatting boundaries → multiple consecutive runs share
 * the same id. We coalesce them into a single span. A run can carry both insertion and
 * deletion ids (rare — proposed replacement); we emit one span per (id, kind) pair.
 *
 * Spans crossing paragraph breaks are emitted as one span per paragraph, all sharing the
 * same id. Style-change suggestions (`suggestedTextStyleChanges` etc.) are ignored —
 * v1 covers insert/delete only.
 */
export function extractSuggestions(doc: Document): SuggestionSpan[] {
  const out: SuggestionSpan[] = [];
  out.push(...extractFrom("body", "", doc.body?.content));
  for (const [id, h] of Object.entries(doc.headers ?? {})) {
    out.push(...extractFrom("header", id, h.content));
  }
  for (const [id, f] of Object.entries(doc.footers ?? {})) {
    out.push(...extractFrom("footer", id, f.content));
  }
  for (const [id, fn] of Object.entries(doc.footnotes ?? {})) {
    out.push(...extractFrom("footnote", id, fn.content));
  }
  return out;
}

function extractFrom(
  region: DocRegion,
  regionId: string,
  content: StructuralElement[] | undefined,
): SuggestionSpan[] {
  const spans: SuggestionSpan[] = [];
  let paragraphIndex = -1;

  for (const el of content ?? []) {
    if (!el.paragraph) continue;
    paragraphIndex++;

    const elements = el.paragraph.elements ?? [];
    let paragraphText = "";
    for (const pe of elements) {
      if (pe.textRun?.content) paragraphText += pe.textRun.content;
    }
    if (paragraphText.endsWith("\n")) paragraphText = paragraphText.slice(0, -1);

    interface OpenSpan {
      kind: SuggestionKind;
      offset: number;
      text: string;
    }
    const open = new Map<string, OpenSpan>();
    let cursor = 0;

    const flush = (id: string) => {
      const s = open.get(id);
      if (!s) return;
      spans.push({
        id,
        kind: s.kind,
        region,
        regionId,
        paragraphIndex,
        paragraphText,
        offset: s.offset,
        length: s.text.length,
        text: s.text,
      });
      open.delete(id);
    };

    for (const pe of elements) {
      const run = pe.textRun;
      if (!run) continue;
      const content = run.content ?? "";
      const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;

      const insertIds = run.suggestedInsertionIds ?? [];
      const deleteIds = run.suggestedDeletionIds ?? [];
      const activeIds = new Set([...insertIds, ...deleteIds]);

      for (const id of [...open.keys()]) {
        if (!activeIds.has(id)) flush(id);
      }

      const extend = (id: string, kind: SuggestionKind) => {
        const existing = open.get(id);
        if (existing && existing.kind === kind) {
          existing.text += trimmed;
        } else {
          if (existing) flush(id);
          open.set(id, { kind, offset: cursor, text: trimmed });
        }
      };
      for (const id of insertIds) extend(id, "suggestion_insert");
      for (const id of deleteIds) extend(id, "suggestion_delete");

      cursor += trimmed.length;
    }

    for (const id of [...open.keys()]) flush(id);
  }

  return spans;
}
