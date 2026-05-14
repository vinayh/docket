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

// TEMPORARY fallback used only when the backend can't supply the canonical
// title — i.e. untracked docs (no `drive.file` grant yet, pre-Picker), and
// legacy tracked rows that pre-date `project.name` / `version.name`. For
// every other case, `DocState.title` from `/api/extension/doc-state` (sourced
// from Drive `files.get`) is the source of truth.
//
// Heuristic: Docs formats `document.title` as `<DocName> - <Localized Google
// Docs>`. The brand "Google" is never translated; only the surrounding
// product noun is ("Docs" / "Documentos" / "ドキュメント" / "文档" /
// "Документы" / …). So we strip the last ` - <suffix>` only when <suffix>
// contains the literal word "Google" — locale-agnostic, and safe against
// user titles like "Foo - Bar" that happen to contain a dash but no Docs
// suffix. Still best-effort; a user title that itself ends with "… - Google
// Something" would mis-strip.
const DOCS_SUFFIX = /\s-\s[^-]*\bGoogle\b[^-]*$/i;

export function cleanDocTitleFallback(rawTitle: string | undefined | null): string {
  if (!rawTitle) return "";
  const trimmed = rawTitle.trim();
  const stripped = trimmed.replace(DOCS_SUFFIX, "").trim();
  return stripped || trimmed;
}
