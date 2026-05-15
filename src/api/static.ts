/**
 * Static-asset handler for the backend's compiled CSS (and any other
 * files we drop under `dist/` at build time). Mirrors `fonts.ts`: a
 * tight allow-list keyed by filename, long-cache + immutable.
 *
 * The Dockerfile's styles stage emits `dist/backend.css`; locally the
 * developer runs `bunx tailwindcss -i src/api/styles/input.css -o
 * dist/backend.css` once (or as part of a watch script). Paths are
 * resolved relative to the cwd (= repo root in dev, /app in the image).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const STATIC_FILES: Record<string, { path: string; contentType: string }> = {
  "backend.css": { path: "dist/backend.css", contentType: "text/css; charset=utf-8" },
};

export async function handleStaticAsset(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.pathname.replace(/^\/static\//, "");
  const entry = STATIC_FILES[name];
  if (!entry) return new Response("not found", { status: 404 });
  const abs = resolve(entry.path);
  if (!existsSync(abs)) return new Response("not built", { status: 503 });
  return new Response(Bun.file(abs), {
    status: 200,
    headers: {
      "content-type": entry.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
