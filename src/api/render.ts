/**
 * Preact SSR helper for the backend HTML pages. Each route builds a
 * VNode (typed props, JSX-default escaping) and `renderPage` wraps it
 * with the standard response headers + per-route CSP.
 *
 * `nonce()` returns a base64-ish identifier suitable for `script-src
 * 'nonce-…'`. The route handler generates one per response, passes it
 * to the component that renders the inline `<script>`, and embeds the
 * same value in the CSP header.
 */

import { renderToString } from "preact-render-to-string";
import type { VNode } from "preact";

export interface RenderPageOptions {
  status?: number;
  csp: string;
  cacheControl?: string;
}

export function renderPage(vnode: VNode, opts: RenderPageOptions): Response {
  const body = renderToString(vnode);
  return new Response(`<!doctype html>${body}`, {
    status: opts.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": opts.cacheControl ?? "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": opts.csp,
    },
  });
}

export function nonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
