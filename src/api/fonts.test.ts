import { describe, expect, test } from "bun:test";
import { handleFontRequest } from "./fonts.ts";

describe("handleFontRequest", () => {
  test("serves the vendored bagel-fat-one woff2", async () => {
    const req = new Request("http://localhost/fonts/bagel-fat-one.woff2");
    const res = await handleFontRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = await res.arrayBuffer();
    // woff2 magic number "wOF2" (0x77 0x4F 0x46 0x32) — confirms we're serving
    // an actual woff2 file, not an HTML error page or something else.
    const view = new Uint8Array(bytes);
    expect(view[0]).toBe(0x77);
    expect(view[1]).toBe(0x4f);
    expect(view[2]).toBe(0x46);
    expect(view[3]).toBe(0x32);
  });

  test("unknown filenames return 404", async () => {
    const req = new Request("http://localhost/fonts/not-real.woff2");
    const res = await handleFontRequest(req);
    expect(res.status).toBe(404);
  });
});
