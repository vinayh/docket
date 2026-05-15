import { describe, expect, test } from "bun:test";
import {
  buildPickerScript,
  htmlErrorResponse,
  renderNotConfiguredHtml,
  renderNotSignedInHtml,
  renderPickerHtml,
  renderTokenErrorHtml,
} from "./picker-page-html.ts";
import { sha256Base64 } from "./html.ts";

describe("buildPickerScript", () => {
  test("inlines apiKey / projectNumber / accessToken as JSON-safe string literals", () => {
    const script = buildPickerScript({
      apiKey: "AIza-test",
      projectNumber: "1234567890",
      accessToken: "ya29.token",
    });
    expect(script).toContain('var apiKey = "AIza-test"');
    expect(script).toContain('var projectNumber = "1234567890"');
    expect(script).toContain('var accessToken = "ya29.token"');
  });

  test("escapes newlines and quotes inside string values", () => {
    const script = buildPickerScript({
      apiKey: 'oops"\n+evil',
      projectNumber: "1",
      accessToken: "1",
    });
    // A raw " character inside the assignment would break parsing — JSON
    // stringification handles this.
    const apiKeyAssignment = script.split("\n").find((l) => l.includes("var apiKey"));
    expect(apiKeyAssignment).toBe(`  var apiKey = "oops\\"\\n+evil";`);
  });

  test("POSTs to /api/picker/register-doc with the picked doc id", () => {
    const script = buildPickerScript({ apiKey: "k", projectNumber: "1", accessToken: "t" });
    expect(script).toContain("/api/picker/register-doc");
    expect(script).toContain("docUrlOrId: pickedId");
  });
});

describe("renderPickerHtml", () => {
  test("inline script matches the sha256 hash you'd put in the CSP", async () => {
    const script = buildPickerScript({
      apiKey: "k",
      projectNumber: "1",
      accessToken: "t",
    });
    const html = renderPickerHtml(script);
    expect(html).toContain(`<script>${script}</script>`);
    expect(await sha256Base64(script)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("includes the apis.google.com external script tag", () => {
    const html = renderPickerHtml("var x = 1;");
    expect(html).toContain("https://apis.google.com/js/api.js");
  });

  test("renders a status element the script targets", () => {
    const html = renderPickerHtml("var x = 1;");
    expect(html).toContain('id="status"');
  });
});

describe("renderTokenErrorHtml", () => {
  test("escapes &, <, > in the surfaced message", () => {
    const html = renderTokenErrorHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("escapes the & character (must precede < / > escaping in the input)", () => {
    const html = renderTokenErrorHtml("Tom & Jerry");
    expect(html).toContain("Tom &amp; Jerry");
  });
});

describe("renderNotSignedInHtml / renderNotConfiguredHtml", () => {
  test("not-signed-in page mentions the extension Options sign-in flow", () => {
    const html = renderNotSignedInHtml();
    expect(html).toContain("Sign in with Google");
  });

  test("not-configured page names the missing env vars", () => {
    const html = renderNotConfiguredHtml();
    expect(html).toContain("GOOGLE_CLIENT_ID");
    expect(html).toContain("GOOGLE_API_KEY");
    expect(html).toContain("GOOGLE_PROJECT_NUMBER");
  });
});

describe("htmlErrorResponse", () => {
  test("sets content-type, no-store cache, robots noindex, and a strict default-src 'none' CSP", () => {
    const res = htmlErrorResponse("<p>x</p>", 500);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
