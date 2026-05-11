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
 * Strip the trailing locale-specific " - Google Docs" suffix from a tab
 * title, leaving just the doc name. The browser sets `tab.title` from
 * `document.title`, which Docs formats as `<DocName> - Google Docs` in
 * English and `<DocName> - <Localized Google Docs>` in other locales. We
 * split on the last " - " separator: if it leaves something non-empty
 * behind, that's the doc name; otherwise return the original.
 *
 * Pre-docx-ingest, this stripping was done by reading the title input
 * directly off the Docs DOM via a content script and caching it per docId.
 * The content script is gone; this helper covers the same locale-suffix
 * concern with a single regex.
 */
export function cleanDocTitle(rawTitle: string | undefined | null): string {
  if (!rawTitle) return "";
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx <= 0) return rawTitle.trim();
  const head = rawTitle.slice(0, idx).trim();
  return head || rawTitle.trim();
}
