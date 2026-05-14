/**
 * Helpers shared by the inline-script HTML pages served by `/api/auth/ext/success`
 * and `/api/picker/page`. Both pages inline a `<script>` whose body is locked
 * down by a per-response `sha256` CSP hash (no blanket `unsafe-inline`).
 *
 * `renderHashedScriptHtml` only produces the markup; the caller composes the
 * matching `Content-Security-Policy` header using `sha256Base64` so per-page
 * extras (e.g. picker-page's `https://apis.google.com` script-src + frame-src)
 * stay where the route owns them. Callers must include `font-src 'self'` in
 * their CSP if they want the Bagel Fat One brand mark to load.
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

/**
 * Themed page styles for the backend's transient HTML pages — same cream /
 * ink / accent palette as the extension surfaces and the marketing site
 * (see surfaces/extension/ui/tokens.css). The Bagel Fat One face for the
 * "Margin" brand mark is self-hosted via `/fonts/bagel-fat-one.woff2`;
 * including it here means the CSP must allow `font-src 'self'`.
 */
const DEFAULT_PAGE_STYLE = `<style>
  @font-face {
    font-family: 'Bagel Fat One';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/fonts/bagel-fat-one.woff2') format('woff2');
  }
  :root {
    --color-cream: #faf6ec;
    --color-ink: #15140f;
    --color-ink-2: #2a2823;
    --color-muted: #5d5a4f;
    --color-rule: #d8d2c2;
    --color-accent: #fff15c;
    --color-good: #2f6f3a;
    --color-bad: #8a3a13;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--color-cream); color: var(--color-ink); }
  body {
    font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 15px;
    line-height: 1.55;
    margin: 0;
    padding: 4rem 1.5rem;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 32rem;
    margin: 0 auto;
  }
  h1 {
    font-family: 'Bagel Fat One', 'Recoleta', 'Fraunces', ui-serif, serif;
    font-weight: 400;
    font-size: 36px;
    letter-spacing: -0.01em;
    line-height: 1.05;
    margin: 0 0 1rem;
    color: var(--color-ink);
  }
  p { margin: 0.5rem 0; color: var(--color-ink-2); }
  p[data-tone="error"] { color: var(--color-bad); }
  p[data-tone="ok"] { color: var(--color-good); }
  a {
    color: var(--color-ink);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
    text-decoration-color: var(--color-accent);
  }
  a:hover { text-decoration-color: var(--color-ink); }
  code {
    font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    background: rgba(21, 20, 15, 0.06);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    color: var(--color-ink-2);
  }
  .footer {
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-rule);
    font-size: 12px;
    color: var(--color-muted);
  }
  ::selection { background: var(--color-accent); color: var(--color-ink); }
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
<main>
${opts.bodyMarkup}
</main>
${externals}
<script>${opts.inlineScript}</script>
</body>
</html>`;
}

/**
 * Standalone page shell for static HTML (no inline scripts). Same theme as
 * `renderHashedScriptHtml`; used by the picker error pages and the magic-link
 * review-action confirmation page.
 */
export function renderStaticPageHtml(title: string, bodyMarkup: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
${DEFAULT_PAGE_STYLE}
</head>
<body>
<main>
${bodyMarkup}
</main>
</body>
</html>`;
}
