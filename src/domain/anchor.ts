import type { Document } from "../google/docs.ts";
import {
  extractAllParagraphs,
  type ParagraphText,
  type RegionParagraphText,
} from "../google/docs.ts";
import type { CommentAnchor, DocRegion } from "../db/schema.ts";

const CONTEXT_CHARS = 32;

export function paragraphHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export interface AnchorMatch {
  anchor: CommentAnchor;
  paragraph: RegionParagraphText;
}

/**
 * Single source of truth for "build a CommentAnchor at paragraph + offset".
 * Slices ±CONTEXT_CHARS of context, hashes the paragraph, fills the
 * structuralPosition. Region info is included when the paragraph isn't body
 * (back-compat: body anchors omit `region`/`regionId`).
 *
 * `matchLen` lets fuzzy-match callers report a different end than
 * `quoted.length` — used when the matched span includes target-side
 * insertions between equal segments.
 */
export function anchorAt(
  quoted: string,
  paragraph: ParagraphText | RegionParagraphText,
  offset: number,
  opts: { matchLen?: number; region?: DocRegion; regionId?: string } = {},
): CommentAnchor {
  const region: DocRegion =
    opts.region ?? ("region" in paragraph ? paragraph.region : "body");
  const regionId =
    opts.regionId ?? ("regionId" in paragraph ? paragraph.regionId : "");
  const len = opts.matchLen ?? quoted.length;
  const before = paragraph.text.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
  const after = paragraph.text.slice(offset + len, offset + len + CONTEXT_CHARS);
  return {
    quotedText: quoted,
    contextBefore: before || undefined,
    contextAfter: after || undefined,
    paragraphHash: paragraphHash(paragraph.text),
    structuralPosition: {
      ...(region !== "body" ? { region, regionId } : {}),
      paragraphIndex: paragraph.paragraphIndex,
      offset,
    },
  };
}

/**
 * Compute a CommentAnchor for `quotedText` against the given document. Walks
 * every region (body, headers, footers, footnotes) so a comment quoted in a
 * footer doesn't get silently mis-anchored to the body.
 *
 * Strategy: scan paragraphs in walk order and pick the first one that
 * contains `quotedText` as a substring. Returns null if no paragraph
 * contains it. The reanchoring engine handles fuzzy matches and orphans.
 */
export function buildAnchor(doc: Document, quotedText: string): AnchorMatch | null {
  if (!quotedText) return null;
  for (const p of extractAllParagraphs(doc)) {
    const offset = p.text.indexOf(quotedText);
    if (offset === -1) continue;
    return { paragraph: p, anchor: anchorAt(quotedText, p, offset) };
  }
  return null;
}

/**
 * Anchor for a comment whose quoted text we couldn't locate (rare — typically
 * unanchored Drive comments, or quoted text that's been edited away). Stored so
 * the reanchoring engine and reconciliation UI can surface it as orphaned.
 */
export function orphanAnchor(quotedText: string): CommentAnchor {
  return { quotedText };
}
