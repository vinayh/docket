import { diffArrays, diffWordsWithSpace, type Change } from "diff";
import type {
  ParagraphSummary,
  RunSummary,
  TextStyleSummary,
} from "../../../utils/types.ts";

/**
 * Two-pass diff for the side-panel "structured version diff" view.
 *
 * Pass 1 — paragraph alignment: `diffArrays` with a custom comparator
 * that treats two paragraphs as equal when both their plaintext AND
 * `namedStyleType` match. Heading-level changes thus break alignment
 * and surface as a delete/insert pair, which is the desired behaviour
 * (a paragraph whose heading level changed reads visually different).
 *
 * Pass 2 — intra-paragraph word diff: for matched paragraphs whose
 * plaintext is identical, we check for style-only changes (run-style
 * hashes differ). When plaintext differs, `diffWordsWithSpace`
 * produces a per-word patch so the renderer can interleave kept /
 * added / removed spans inside the paragraph rows.
 *
 * Returns a sequence of `DiffRow`s, each describing one row in the
 * side-by-side render. The renderer maps each row to a `<tr>` with two
 * cells (from / to) — except for added/removed rows, which fill only
 * one side.
 */

export type DiffRow =
  | { kind: "match"; from: ParagraphSummary; to: ParagraphSummary }
  | { kind: "style-changed"; from: ParagraphSummary; to: ParagraphSummary }
  | {
      kind: "modified";
      from: ParagraphSummary;
      to: ParagraphSummary;
      words: Change[];
    }
  | { kind: "added"; to: ParagraphSummary }
  | { kind: "removed"; from: ParagraphSummary };

export function alignParagraphs(
  from: readonly ParagraphSummary[],
  to: readonly ParagraphSummary[],
): DiffRow[] {
  const aligned = diffArrays(
    from as ParagraphSummary[],
    to as ParagraphSummary[],
    { comparator: sameParagraphKey },
  );

  const rows: DiffRow[] = [];
  // Cursors into the original `from`/`to` arrays so an "unchanged" block
  // can recover the actual `to`-side paragraph (with its real runs, not
  // jsdiff's canonical representative).
  let fromCursor = 0;
  let toCursor = 0;

  for (let i = 0; i < aligned.length; i++) {
    const part = aligned[i]!;
    const values = part.value as ParagraphSummary[];

    if (!part.added && !part.removed) {
      for (let j = 0; j < values.length; j++) {
        const fromP = from[fromCursor + j]!;
        const toP = to[toCursor + j]!;
        if (runStylesEqual(fromP.runs, toP.runs)) {
          rows.push({ kind: "match", from: fromP, to: toP });
        } else {
          rows.push({ kind: "style-changed", from: fromP, to: toP });
        }
      }
      fromCursor += values.length;
      toCursor += values.length;
      continue;
    }

    // Adjacent removed→added: pair them 1:1 up to min(length), then
    // tail-emit unmatched ones as pure add/remove rows.
    if (part.removed && aligned[i + 1]?.added) {
      const next = aligned[i + 1]!;
      const removed = values;
      const added = next.value as ParagraphSummary[];
      const pairCount = Math.min(removed.length, added.length);
      for (let j = 0; j < pairCount; j++) {
        const fromP = from[fromCursor + j]!;
        const toP = to[toCursor + j]!;
        rows.push({
          kind: "modified",
          from: fromP,
          to: toP,
          words: diffWordsWithSpace(fromP.plaintext, toP.plaintext),
        });
      }
      for (let j = pairCount; j < removed.length; j++) {
        rows.push({ kind: "removed", from: from[fromCursor + j]! });
      }
      for (let j = pairCount; j < added.length; j++) {
        rows.push({ kind: "added", to: to[toCursor + j]! });
      }
      fromCursor += removed.length;
      toCursor += added.length;
      i++; // we consumed the next block
      continue;
    }

    if (part.removed) {
      for (let j = 0; j < values.length; j++) {
        rows.push({ kind: "removed", from: from[fromCursor + j]! });
      }
      fromCursor += values.length;
      continue;
    }

    if (part.added) {
      for (let j = 0; j < values.length; j++) {
        rows.push({ kind: "added", to: to[toCursor + j]! });
      }
      toCursor += values.length;
    }
  }

  return rows;
}

function sameParagraphKey(a: ParagraphSummary, b: ParagraphSummary): boolean {
  return a.plaintext === b.plaintext && a.namedStyleType === b.namedStyleType;
}

function runStylesEqual(
  a: readonly RunSummary[],
  b: readonly RunSummary[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!;
    const rb = b[i]!;
    if (ra.content !== rb.content) return false;
    if (!sameStyle(ra.style, rb.style)) return false;
  }
  return true;
}

function sameStyle(
  a: TextStyleSummary | null,
  b: TextStyleSummary | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const key = ka[i]! as keyof TextStyleSummary;
    if (a[key] !== b[key]) return false;
  }
  return true;
}
