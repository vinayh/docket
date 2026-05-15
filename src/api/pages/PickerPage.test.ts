import { describe, expect, test } from "bun:test";
import { buildPickerScript } from "./PickerPage.script.ts";

/**
 * Inline picker script generator. The full picker page is exercised by
 * `picker-page.test.ts`; this file pins the script body's escape
 * boundary (JSON.stringify) and the runtime API surface it depends on.
 */
describe("buildPickerScript", () => {
  test("injects the three inputs as JS-safe string literals", () => {
    const script = buildPickerScript({
      apiKey: "k1",
      projectNumber: "proj-1",
      accessToken: "tkn",
    });
    expect(script).toContain('var apiKey = "k1"');
    expect(script).toContain('var projectNumber = "proj-1"');
    expect(script).toContain('var accessToken = "tkn"');
  });

  test("escapes quotes, newlines, and </script> separators", () => {
    const evil = 'oops"\n+evil';
    const script = buildPickerScript({
      apiKey: evil,
      projectNumber: "p",
      accessToken: "t",
    });
    // JSON.stringify escapes the inner `"` and `\n` so the JS literal stays valid
    // and `</script>` cannot end the surrounding `<script>` tag.
    expect(script).toContain('"oops\\"\\n+evil"');
    expect(script).not.toContain("oops\"\n+evil");
  });

  test("references the runtime API surface the picker needs", () => {
    const script = buildPickerScript({ apiKey: "k", projectNumber: "p", accessToken: "t" });
    expect(script).toContain("/api/picker/register-doc");
    expect(script).toContain("docUrlOrId: pickedId");
    expect(script).toContain("google.picker");
  });
});
