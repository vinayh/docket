/**
 * Doc-id rules. Real Google Doc ids are base64url-ish: `[A-Za-z0-9_-]`,
 * typically 44 chars. We require at least 20 — same lower bound for both the
 * embedded-in-URL form and the bare-id form so the parser accepts an id iff
 * it would also accept the same id pasted directly. Mirrored verbatim in
 * `surfaces/extension/utils/ids.ts` (the extension can't import from the
 * backend); the cross-surface test in `google-doc-url.test.ts` guards the
 * equivalence.
 */
const URL_PATTERN = /\/document\/d\/([A-Za-z0-9_-]{20,})/;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

export function parseGoogleDocId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(URL_PATTERN);
  if (m && m[1]) return m[1];
  if (ID_PATTERN.test(trimmed)) return trimmed;
  throw new Error(`unrecognized Google Doc URL or id: ${input}`);
}

export function googleDocUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}
