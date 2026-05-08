import type { Document } from "../google/docs.ts";
import { extractParagraphs, type ParagraphText } from "../google/docs.ts";
import type { CommentAnchor } from "../db/schema.ts";

const CONTEXT_CHARS = 32;

export function paragraphHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export interface AnchorMatch {
  anchor: CommentAnchor;
  paragraph: ParagraphText;
}

/**
 * Compute a CommentAnchor for `quotedText` against the given document. Used both for
 * ingesting the origin-version anchor of a Drive comment and as the seed for the
 * reanchoring engine when projecting onto another version.
 *
 * Strategy: scan paragraphs and pick the first one that contains `quotedText` as a
 * substring. Returns null if no paragraph contains it. The reanchoring engine will
 * handle fuzzy matches and orphans.
 */
export function buildAnchor(doc: Document, quotedText: string): AnchorMatch | null {
  if (!quotedText) return null;
  const paragraphs = extractParagraphs(doc);
  for (const p of paragraphs) {
    const offset = p.text.indexOf(quotedText);
    if (offset === -1) continue;

    const contextBefore = p.text.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
    const contextAfter = p.text.slice(
      offset + quotedText.length,
      offset + quotedText.length + CONTEXT_CHARS,
    );

    return {
      paragraph: p,
      anchor: {
        quotedText,
        contextBefore: contextBefore || undefined,
        contextAfter: contextAfter || undefined,
        paragraphHash: paragraphHash(p.text),
        structuralPosition: { paragraphIndex: p.paragraphIndex, offset },
      },
    };
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
