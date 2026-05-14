/**
 * Self-hosted font assets used by the backend HTML pages (sign-in success,
 * Drive Picker, picker errors, magic-link review action). Same display font
 * as the extension surfaces (see `surfaces/extension/ui/tokens.css`); served
 * here so those pages can render the brand mark in Bagel Fat One without
 * widening their CSP to `font-src https://fonts.gstatic.com`.
 *
 * Long-cache + immutable: filenames are content-stable per @fontsource
 * release, and we publish a new server build to roll the version anyway.
 */

import { existsSync } from "node:fs";

const FONT_FILES: Record<string, string> = {
  "bagel-fat-one.woff2": resolveFontPath(
    "@fontsource/bagel-fat-one/files/bagel-fat-one-latin-400-normal.woff2",
  ),
};

function resolveFontPath(specifier: string): string {
  const resolved = Bun.resolveSync(specifier, process.cwd());
  if (!existsSync(resolved)) {
    throw new Error(`font asset missing on disk: ${resolved}`);
  }
  return resolved;
}

export async function handleFontRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.pathname.replace(/^\/fonts\//, "");
  const path = FONT_FILES[name];
  if (!path) return new Response("not found", { status: 404 });
  const file = Bun.file(path);
  return new Response(file, {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
