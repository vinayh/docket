import { describe, expect, test } from "bun:test";
import { cleanDocTitleFallback, parseDocIdFromUrl } from "./ids.ts";

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

describe("cleanDocTitleFallback", () => {
  test('strips a trailing " - Google Docs" suffix', () => {
    expect(cleanDocTitleFallback("My Doc - Google Docs")).toBe("My Doc");
  });

  test("strips localized variants — the brand 'Google' is the anchor", () => {
    expect(cleanDocTitleFallback("Mon Doc - Documents Google")).toBe("Mon Doc");
    expect(cleanDocTitleFallback("Mi Doc - Documentos de Google")).toBe("Mi Doc");
    expect(cleanDocTitleFallback("Mein Doc - Google Dokumente")).toBe("Mein Doc");
    expect(cleanDocTitleFallback("私のドキュメント - Google ドキュメント")).toBe(
      "私のドキュメント",
    );
    expect(cleanDocTitleFallback("我的文件 - Google 文档")).toBe("我的文件");
    expect(cleanDocTitleFallback("Мой документ - Google Документы")).toBe("Мой документ");
  });

  test("strips only the Docs suffix, preserving in-name dashes", () => {
    expect(cleanDocTitleFallback("Foo - Bar - Google Docs")).toBe("Foo - Bar");
  });

  test("leaves a user title with a dash but no Docs suffix untouched", () => {
    // Could happen mid-load, when another extension overrides the title,
    // or if tab.title hasn't synced. Previous heuristic wrongly returned "Foo".
    expect(cleanDocTitleFallback("Foo - Bar")).toBe("Foo - Bar");
    expect(cleanDocTitleFallback("Q4 plan - draft")).toBe("Q4 plan - draft");
  });

  test("returns the original when there is no ' - ' separator", () => {
    expect(cleanDocTitleFallback("Untitled document")).toBe("Untitled document");
  });

  test("falls back to the original when stripping would leave an empty name", () => {
    expect(cleanDocTitleFallback(" - Google Docs")).toBe("- Google Docs");
  });

  test("empty / null / undefined → empty string", () => {
    expect(cleanDocTitleFallback("")).toBe("");
    expect(cleanDocTitleFallback(null)).toBe("");
    expect(cleanDocTitleFallback(undefined)).toBe("");
  });
});
