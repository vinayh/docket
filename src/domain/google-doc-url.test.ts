import { test, expect, describe } from "bun:test";
import { parseGoogleDocId, googleDocUrl } from "./google-doc-url.ts";
import { parseDocIdFromUrl } from "../../surfaces/extension/utils/ids.ts";

describe("parseGoogleDocId", () => {
  test("extracts id from a standard edit URL", () => {
    expect(
      parseGoogleDocId("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit"),
    ).toBe("1AbCdEfGhIjKlMnOpQrStUv");
  });

  test("extracts id from a URL with query and fragment", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/document/d/abcDEF123_-456789012345/edit?tab=t.0&usp=sharing#heading",
      ),
    ).toBe("abcDEF123_-456789012345");
  });

  test("extracts id from a URL ending at /edit", () => {
    expect(
      parseGoogleDocId("https://docs.google.com/document/d/abcDEF123_-456789012345"),
    ).toBe("abcDEF123_-456789012345");
  });

  test("accepts a bare id", () => {
    expect(parseGoogleDocId("1AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(
      parseGoogleDocId("  https://docs.google.com/document/d/abcDEF123_-456789012345/edit  "),
    ).toBe("abcDEF123_-456789012345");
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

/**
 * The extension bundle can't import backend code, so its URL parser is a
 * hand-mirrored copy. These cases pin the two parsers to the same accept/
 * reject set: drift here is the bug we'd catch.
 */
describe("doc-id parser parity (backend ↔ extension)", () => {
  const FORTYTWO = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDE";
  const accepts: { url: string; id: string }[] = [
    {
      url: `https://docs.google.com/document/d/${FORTYTWO}/edit`,
      id: FORTYTWO,
    },
    {
      url: `https://docs.google.com/document/d/${FORTYTWO}/edit?tab=t.0#h`,
      id: FORTYTWO,
    },
    {
      url: `https://docs.google.com/document/d/${FORTYTWO}`,
      id: FORTYTWO,
    },
  ];
  const rejects = [
    "https://drive.google.com/file/d/abc/view",
    "https://docs.google.com/document/d/short", // < 20 chars
    "https://example.com/foo",
  ];

  for (const { url, id } of accepts) {
    test(`both parsers accept ${url}`, () => {
      expect(parseGoogleDocId(url)).toBe(id);
      expect(parseDocIdFromUrl(url)).toBe(id);
    });
  }

  for (const url of rejects) {
    test(`both parsers reject ${url}`, () => {
      expect(() => parseGoogleDocId(url)).toThrow();
      expect(parseDocIdFromUrl(url)).toBeNull();
    });
  }
});
