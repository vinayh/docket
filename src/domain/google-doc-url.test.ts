import { test, expect, describe } from "bun:test";
import { parseGoogleDocId, googleDocUrl } from "./google-doc-url.ts";

describe("parseGoogleDocId", () => {
  test("extracts id from a standard edit URL", () => {
    expect(
      parseGoogleDocId("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit"),
    ).toBe("1AbCdEfGhIjKlMnOpQrStUv");
  });

  test("extracts id from a URL with query and fragment", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/document/d/abcDEF123_-456/edit?tab=t.0&usp=sharing#heading",
      ),
    ).toBe("abcDEF123_-456");
  });

  test("extracts id from a URL ending at /edit", () => {
    expect(
      parseGoogleDocId("https://docs.google.com/document/d/abcDEF123_-456"),
    ).toBe("abcDEF123_-456");
  });

  test("accepts a bare id", () => {
    expect(parseGoogleDocId("1AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(
      parseGoogleDocId("  https://docs.google.com/document/d/abcDEF123_-456/edit  "),
    ).toBe("abcDEF123_-456");
  });

  test("rejects a non-doc URL", () => {
    expect(() =>
      parseGoogleDocId("https://drive.google.com/file/d/abc/view"),
    ).toThrow(/unrecognized/);
  });

  test("rejects a short string that doesn't look like an id", () => {
    expect(() => parseGoogleDocId("hello")).toThrow(/unrecognized/);
  });
});

describe("googleDocUrl", () => {
  test("builds a docs URL from an id", () => {
    expect(googleDocUrl("abc123")).toBe("https://docs.google.com/document/d/abc123/edit");
  });
});
