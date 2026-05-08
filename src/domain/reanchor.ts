import type { CommentAnchor } from "../db/schema.ts";
import type { Document } from "../google/docs.ts";
import { extractParagraphs, type ParagraphText } from "../google/docs.ts";
import { paragraphHash, orphanAnchor } from "./anchor.ts";

/**
 * Result of projecting a source anchor onto a target document.
 *
 * Confidence is 0–100. Status mirrors `comment_projection.projection_status`:
 *   clean   ≥ CLEAN_THRESHOLD  — paragraph hash + quoted text both match.
 *   fuzzy   ≥ FUZZY_THRESHOLD  — quoted text drifted (paragraph edited, contiguous fragment).
 *   orphan  otherwise          — quoted text not recoverable; surface for human review.
 */
export interface ReanchorResult {
  anchor: CommentAnchor;
  confidence: number;
  status: "clean" | "fuzzy" | "orphaned";
  paragraph?: ParagraphText;
}

export const CLEAN_THRESHOLD = 90;
export const FUZZY_THRESHOLD = 50;

const CONTEXT_CHARS = 32;

/**
 * Locate the best match for a source anchor in `doc`. SPEC §5 algorithm:
 *  1. Same paragraph hash + exact quoted-text substring → 100 (clean).
 *  2. Exact quoted-text substring in any paragraph → 85–95 depending on context match.
 *  3. Longest-common-substring fuzzy fallback within a paragraph → ≤ 80.
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
    };
  }

  // Pass 3 — longest common substring within a paragraph.
  let best: { p: ParagraphText; offset: number; matchLen: number; ratio: number } | null = null;
  for (const p of paragraphs) {
    const lcs = longestCommonSubstring(quoted, p.text);
    if (lcs.length === 0) continue;
    const ratio = lcs.length / quoted.length;
    if (!best || ratio > best.ratio) {
      best = { p, offset: lcs.offsetInB, matchLen: lcs.length, ratio };
    }
  }

  if (best && best.ratio >= 0.5) {
    const confidence = Math.min(80, Math.round(best.ratio * 80));
    return {
      anchor: fuzzyAnchorAt(quoted, best.p, best.offset, best.matchLen),
      confidence,
      status: confidence >= CLEAN_THRESHOLD ? "clean" : "fuzzy",
      paragraph: best.p,
    };
  }

  return { anchor: orphanAnchor(quoted), confidence: 0, status: "orphaned" };
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

/**
 * Length and position of the longest contiguous substring shared between `a` and `b`,
 * with the position reported as the offset within `b`. Empty strings yield length 0.
 */
export function longestCommonSubstring(
  a: string,
  b: string,
): { offsetInB: number; length: number } {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return { offsetInB: 0, length: 0 };

  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  let bestLen = 0;
  let bestEndJ = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        const v = prev[j - 1]! + 1;
        curr[j] = v;
        if (v > bestLen) {
          bestLen = v;
          bestEndJ = j;
        }
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }

  return { offsetInB: bestEndJ - bestLen, length: bestLen };
}
