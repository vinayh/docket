/**
 * Self-hosted font assets used by the backend HTML pages (sign-in success,
 * Drive Picker, picker errors, magic-link review action). Same Bagel Fat One
 * brand mark as the extension surfaces; served here so those pages can render
 * it without widening their CSP to `font-src https://fonts.gstatic.com`.
 *
 * The woff2 is vendored at `src/api/assets/bagel-fat-one.woff2` so the prod
 * image doesn't have to carry the `@fontsource/bagel-fat-one` package — the
 * runtime needs exactly one file, not a node_modules package.
 *
 * Long-cache + immutable: contents are stable per server build; we publish
 * a new image to roll the version anyway.
 */

const FONT_FILES: Record<string, URL> = {
  "bagel-fat-one.woff2": new URL("./assets/bagel-fat-one.woff2", import.meta.url),
};

export async function handleFontRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.pathname.replace(/^\/fonts\//, "");
  const fileUrl = FONT_FILES[name];
  if (!fileUrl) return new Response("not found", { status: 404 });
  return new Response(Bun.file(fileUrl), {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
