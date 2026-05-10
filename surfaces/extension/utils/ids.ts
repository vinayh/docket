/**
 * Helpers for stable identifiers that don't depend on Docs DOM internals.
 */

// Mirrors `URL_PATTERN` in src/domain/google-doc-url.ts. Kept in sync by
// hand because the extension bundle can't import backend code; the
// equivalence is asserted in google-doc-url.test.ts.
const DOC_URL_PATTERN = /\/document\/d\/([A-Za-z0-9_-]{20,})/;

export function parseDocIdFromUrl(href: string): string | null {
  const m = DOC_URL_PATTERN.exec(href);
  return m ? m[1]! : null;
}

/**
 * Stable, idempotent id for a captured reply. We avoid hashing the *position*
 * inside the thread because reply ordering can shift; instead we hash content
 * + author + timestamp + the thread id. Collisions across threads are
 * impossible because the thread id is part of the input.
 *
 * Output is a printable hex digest that fits comfortably in JSON / URL.
 */
export async function stableReplyId(args: {
  kixDiscussionId?: string;
  authorBucket?: string;
  createdAt?: string;
  body: string;
  parentQuotedText?: string;
}): Promise<string> {
  const parts = [
    args.kixDiscussionId ?? "",
    args.authorBucket ?? "",
    args.createdAt ?? "",
    args.parentQuotedText ?? "",
    args.body,
  ];
  const data = new TextEncoder().encode(parts.join("␟"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex; // 32-char prefix is plenty against collision in this scope
}
