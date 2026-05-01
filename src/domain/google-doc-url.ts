const URL_PATTERN = /\/document\/d\/([^/?#]+)/;
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
