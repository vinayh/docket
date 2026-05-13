import { describe, expect, test } from "bun:test";
import { cleanDocTitle, parseDocIdFromUrl } from "./ids.ts";

describe("parseDocIdFromUrl", () => {
  test("extracts the id from a canonical /document/d/<id>/edit url", () => {
    expect(
      parseDocIdFromUrl(
        "https://docs.google.com/document/d/1aB-cD_0123456789zZyXwVu/edit",
      ),
    ).toBe("1aB-cD_0123456789zZyXwVu");
  });

  test("works on the /document/d/<id>/edit?usp=… variant", () => {
    expect(
      parseDocIdFromUrl(
        "https://docs.google.com/document/d/abc_DEF-ghi-1234567890XY/edit?usp=sharing",
      ),
    ).toBe("abc_DEF-ghi-1234567890XY");
  });

  test("returns null when there is no /document/d/<id> segment", () => {
    expect(parseDocIdFromUrl("https://example.com/foo/bar")).toBeNull();
  });

  test("returns null when the id is too short", () => {
    expect(parseDocIdFromUrl("https://docs.google.com/document/d/short/edit")).toBeNull();
  });
});

describe("cleanDocTitle", () => {
  test('strips a trailing " - Google Docs" suffix', () => {
    expect(cleanDocTitle("My Doc - Google Docs")).toBe("My Doc");
  });

  test("strips localized variants — split is on the last ' - '", () => {
    expect(cleanDocTitle("Mon Doc - Documents Google")).toBe("Mon Doc");
    expect(cleanDocTitle("私のドキュメント - Google ドキュメント")).toBe(
      "私のドキュメント",
    );
  });

  test("a title containing ' - ' inside the name keeps everything before the LAST separator", () => {
    expect(cleanDocTitle("Foo - Bar - Google Docs")).toBe("Foo - Bar");
  });

  test("returns the original (trimmed) when there is no ' - ' separator", () => {
    expect(cleanDocTitle("Untitled document")).toBe("Untitled document");
  });

  test("falls back to the original when head is empty (e.g. ' - Suffix')", () => {
    // lastIndexOf(' - ') returns 0; the guard `idx <= 0` falls through to the
    // trimmed original.
    expect(cleanDocTitle(" - Google Docs")).toBe("- Google Docs");
  });

  test("empty / null / undefined → empty string", () => {
    expect(cleanDocTitle("")).toBe("");
    expect(cleanDocTitle(null)).toBe("");
    expect(cleanDocTitle(undefined)).toBe("");
  });
});
