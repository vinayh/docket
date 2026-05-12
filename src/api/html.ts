/**
 * Helpers shared by the inline-script HTML pages served by `/api/auth/ext/success`
 * and `/api/picker/page`. Both pages inline a `<script>` whose body is locked
 * down by a per-response `sha256` CSP hash (no blanket `unsafe-inline`).
 *
 * `renderHashedScriptHtml` only produces the markup; the caller composes the
 * matching `Content-Security-Policy` header using `sha256Base64` so per-page
 * extras (e.g. picker-page's `https://apis.google.com` script-src + frame-src)
 * stay where the route owns them.
 */

/** SHA-256 + base64 of `input`. Used to derive `'sha256-…'` CSP directives. */
export async function sha256Base64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let bin = "";
  const view = new Uint8Array(hash);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin);
}

const DEFAULT_PAGE_STYLE = `<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; color: #222; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #444; }
</style>`;

export interface HashedScriptHtmlOpts {
  /** Page title. Treated as trusted — callers pass static strings. */
  title: string;
  /** Markup between `<body>` and the script tags. */
  bodyMarkup: string;
  /** Inline script content (its sha256 must be in the response CSP). */
  inlineScript: string;
  /** External script URLs inserted before the inline script. */
  externalScriptSrcs?: readonly string[];
  /** Override the default page style block. */
  styleCss?: string;
}

/**
 * Compose an HTML page with referrer + robots blocked, `<base target="_self">`
 * to prevent injected-link breakouts, and one inline `<script>` whose body
 * the caller will pin via CSP hash. Identical shell to what auth-handler and
 * picker-page were each rendering independently.
 */
export function renderHashedScriptHtml(opts: HashedScriptHtmlOpts): string {
  const externals = (opts.externalScriptSrcs ?? [])
    .map((src) => `<script src="${src}" async defer></script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<base target="_self">
<title>${opts.title}</title>
${opts.styleCss ?? DEFAULT_PAGE_STYLE}
</head>
<body>
${opts.bodyMarkup}
${externals}
<script>${opts.inlineScript}</script>
</body>
</html>`;
}
