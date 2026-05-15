import type { ComponentChildren } from "preact";

/**
 * Shared page shell for the backend's HTML pages. Loads the compiled
 * Tailwind output at `/static/backend.css` (served by `handleStaticAsset`);
 * declares the same theme tokens as the marketing site so colors + fonts
 * read as one product. `<base target="_self">` prevents injected-link
 * breakouts; robots/referrer headers are belt-and-braces alongside the
 * response-level headers `renderPage` already sets.
 *
 * Inline scripts get a per-response nonce that must match the page's
 * `script-src 'nonce-…'` CSP directive (route handler generates both).
 */

export interface LayoutProps {
  title: string;
  children?: ComponentChildren;
  /** External `<script src>` tags emitted before the inline script. */
  externalScripts?: readonly string[];
  /** Inline script body. Caller must pass the matching CSP nonce. */
  inlineScript?: string;
  /** Nonce required when `inlineScript` is set. */
  nonce?: string;
}

export function Layout(props: LayoutProps) {
  const externals = props.externalScripts ?? [];
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
        <base target="_self" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/static/backend.css" />
      </head>
      <body class="bg-cream text-ink font-sans antialiased">
        <main class="max-w-lg mx-auto px-6 py-16">{props.children}</main>
        {externals.map((src) => (
          <script src={src} async defer />
        ))}
        {props.inlineScript ? (
          <script
            nonce={props.nonce}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: props.inlineScript }}
          />
        ) : null}
      </body>
    </html>
  );
}
