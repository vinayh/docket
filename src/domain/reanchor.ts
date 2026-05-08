import { diffChars } from "diff";
import type { CommentAnchor } from "../db/schema.ts";
import type { Document } from "../google/docs.ts";
import { extractParagraphs, type ParagraphText } from "../google/docs.ts";
import { paragraphHash, orphanAnchor } from "./anchor.ts";

/**
 * Result of projecting a source anchor onto a target document.
 *
 * Confidence is 0–100. Status mirrors `comment_projection.projection_status`:
 *   clean   ≥ CLEAN_THRESHOLD  — paragraph hash + quoted text both match.
 *   fuzzy   ≥ FUZZY_THRESHOLD  — quoted text drifted; Myers-diff recovers a partial alignment.
 *   orphan  otherwise          — quoted text not recoverable; surface for human review.
 */
export interface ReanchorResult {
  anchor: CommentAnchor;
  confidence: number;
  status: "clean" | "fuzzy" | "orphaned";
  paragraph?: ParagraphText;
  /**
   * The substring in the target paragraph that the source anchor mapped to.
   * For clean / exact matches this equals the source `quotedText`. For fuzzy
   * matches it's the span from the first to the last Myers-diff equal segment
   * — may include inserted target characters between matches so the displayed
   * region covers all source content.
   */
  matchedText?: string;
}

export const CLEAN_THRESHOLD = 90;
export const FUZZY_THRESHOLD = 50;

const CONTEXT_CHARS = 32;

/**
 * Locate the best match for a source anchor in `doc`. SPEC §5 algorithm:
 *  1. Same paragraph hash + exact quoted-text substring → 100 (clean).
 *  2. Exact quoted-text substring in any paragraph → 85–95 depending on context match.
 *  3. Myers-diff (jsdiff) fuzzy fallback within a paragraph → ≤ 80.
 *  4. Otherwise orphan.
 */
export function reanchor(doc: Document, source: CommentAnchor): ReanchorResult {
  const quoted = source.quotedText;
  if (!quoted) {
    return { anchor: orphanAnchor(""), confidence: 0, status: "orphaned" };
  }

  const paragraphs = extractParagraphs(doc);

  // Pass 1 — paragraph hash AND quoted text both intact.
  if (source.paragraphHash) {
    for (const p of paragraphs) {
      if (paragraphHash(p.text) !== source.paragraphHash) continue;
      const offset = p.text.indexOf(quoted);
      if (offset !== -1) {
        return {
          anchor: anchorAt(quoted, p, offset),
          confidence: 100,
          status: "clean",
          paragraph: p,
          matchedText: quoted,
        };
      }
    }
  }

  // Pass 2 — quoted text appears verbatim somewhere.
  const exactCandidates = paragraphs
    .map((p) => ({ p, offset: p.text.indexOf(quoted) }))
    .filter((c) => c.offset !== -1);

  if (exactCandidates.length > 0) {
    const sourceParaIdx = source.structuralPosition?.paragraphIndex;
    if (sourceParaIdx !== undefined) {
      exactCandidates.sort(
        (a, b) =>
          Math.abs(a.p.paragraphIndex - sourceParaIdx) -
          Math.abs(b.p.paragraphIndex - sourceParaIdx),
      );
    }
    const chosen = exactCandidates[0]!;
    let confidence = exactCandidates.length === 1 ? 95 : 85;
    if (!contextMatches(chosen.p.text, chosen.offset, quoted, source)) confidence -= 10;
    return {
      anchor: anchorAt(quoted, chosen.p, chosen.offset),
      confidence,
      status: confidence >= CLEAN_THRESHOLD ? "clean" : "fuzzy",
      paragraph: chosen.p,
      matchedText: quoted,
    };
  }

  // Pass 3 — Myers character diff between source and each paragraph (jsdiff,
  // same algorithm git's default `diff` uses for line-level diffs). Equal
  // segments are matches. We score by total matched chars and report a span
  // from the first to the last match, so insertions like "probably " between
  // matched runs land inside the highlighted region.
  let best: {
    p: ParagraphText;
    spanStart: number;
    spanEnd: number;
    totalMatched: number;
  } | null = null;
  for (const p of paragraphs) {
    const m = matchSpan(quoted, p.text);
    if (!m) continue;
    if (!best || m.totalMatched > best.totalMatched) {
      best = { p, spanStart: m.spanStart, spanEnd: m.spanEnd, totalMatched: m.totalMatched };
    }
  }

  if (best && best.totalMatched / quoted.length >= 0.5) {
    const ratio = best.totalMatched / quoted.length;
    const confidence = Math.min(80, Math.round(ratio * 80));
    const matchLen = best.spanEnd - best.spanStart;
    return {
      anchor: fuzzyAnchorAt(quoted, best.p, best.spanStart, matchLen),
      confidence,
      status: confidence >= CLEAN_THRESHOLD ? "clean" : "fuzzy",
      paragraph: best.p,
      matchedText: best.p.text.slice(best.spanStart, best.spanEnd),
    };
  }

  return { anchor: orphanAnchor(quoted), confidence: 0, status: "orphaned" };
}

/**
 * Equal segments shorter than this are ignored when scoring — character-level
 * Myers otherwise accumulates noise from incidental 1–2 char overlaps in
 * unrelated text. Mirrors the spirit of patience/histogram diff where
 * rare/long anchors carry the alignment.
 */
const MIN_EQUAL_LEN = 3;

/**
 * Walk a Myers character diff (jsdiff) between `source` and `target` and
 * report the smallest target span containing every matching segment plus the
 * total number of source characters matched. Equal segments shorter than
 * {@link MIN_EQUAL_LEN} don't count toward the span or score. Returns null if
 * nothing significant matched.
 */
export function matchSpan(
  source: string,
  target: string,
): { spanStart: number; spanEnd: number; totalMatched: number } | null {
  const parts = diffChars(source, target);
  let targetCursor = 0;
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  let totalMatched = 0;
  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      targetCursor += len;
    } else if (part.removed) {
      // present in source only — doesn't advance target cursor
    } else {
      if (len >= MIN_EQUAL_LEN) {
        if (targetCursor < spanStart) spanStart = targetCursor;
        const end = targetCursor + len;
        if (end > spanEnd) spanEnd = end;
        totalMatched += len;
      }
      targetCursor += len;
    }
  }
  if (totalMatched === 0) return null;
  return { spanStart, spanEnd, totalMatched };
}

function anchorAt(quoted: string, p: ParagraphText, offset: number): CommentAnchor {
  const before = p.text.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
  const after = p.text.slice(offset + quoted.length, offset + quoted.length + CONTEXT_CHARS);
  return {
    quotedText: quoted,
    contextBefore: before || undefined,
    contextAfter: after || undefined,
    paragraphHash: paragraphHash(p.text),
    structuralPosition: { paragraphIndex: p.paragraphIndex, offset },
  };
}

function fuzzyAnchorAt(
  quoted: string,
  p: ParagraphText,
  offset: number,
  matchLen: number,
): CommentAnchor {
  const before = p.text.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
  const after = p.text.slice(offset + matchLen, offset + matchLen + CONTEXT_CHARS);
  return {
    quotedText: quoted,
    contextBefore: before || undefined,
    contextAfter: after || undefined,
    paragraphHash: paragraphHash(p.text),
    structuralPosition: { paragraphIndex: p.paragraphIndex, offset },
  };
}

function contextMatches(
  paragraphText: string,
  offset: number,
  quoted: string,
  source: CommentAnchor,
): boolean {
  const sliceBefore = paragraphText.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
  const sliceAfter = paragraphText.slice(
    offset + quoted.length,
    offset + quoted.length + CONTEXT_CHARS,
  );
  const beforeOk = source.contextBefore
    ? sliceBefore.endsWith(source.contextBefore.slice(-8)) ||
      source.contextBefore.endsWith(sliceBefore.slice(-8))
    : true;
  const afterOk = source.contextAfter
    ? sliceAfter.startsWith(source.contextAfter.slice(0, 8)) ||
      source.contextAfter.startsWith(sliceAfter.slice(0, 8))
    : true;
  return beforeOk && afterOk;
}
