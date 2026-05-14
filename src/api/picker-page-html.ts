import { renderHashedScriptHtml, renderStaticPageHtml } from "./html.ts";

/**
 * HTML rendering for the backend-hosted Drive Picker page. Lives in its own
 * module so `picker-page.ts` stays a thin route handler (auth resolve →
 * compose script → return response).
 */

export interface PickerScriptInputs {
  apiKey: string;
  projectNumber: string;
  accessToken: string;
}

export function buildPickerScript(v: PickerScriptInputs): string {
  // JSON.stringify produces a JS-safe string literal: it escapes quotes,
  // newlines, and the dangerous `</script>` separators. We deliberately
  // *don't* set the Picker's `setQuery` from the originating docId — Picker's
  // title tokenizer ANDs whitespace-split tokens and real Doc titles routinely
  // contain `[brackets]` / `:` / punctuation that defeat it, so a "hint" makes
  // the affordance worse, not better.
  const apiKey = JSON.stringify(v.apiKey);
  const projectNumber = JSON.stringify(v.projectNumber);
  const accessToken = JSON.stringify(v.accessToken);
  return [
    "(function () {",
    `  var apiKey = ${apiKey};`,
    `  var projectNumber = ${projectNumber};`,
    `  var accessToken = ${accessToken};`,
    "  var statusEl = document.getElementById('status');",
    "  function setStatus(text, tone) {",
    "    if (!statusEl) return;",
    "    statusEl.textContent = text;",
    "    if (tone) statusEl.dataset.tone = tone;",
    "    else delete statusEl.dataset.tone;",
    "  }",
    "  function closeSoon() { setTimeout(function () { try { window.close(); } catch (_) {} }, 1500); }",
    "  var deadline = Date.now() + 10000;",
    "  var iv = setInterval(function () {",
    "    if (window.gapi && window.gapi.load) {",
    "      clearInterval(iv);",
    "      window.gapi.load('picker', function () { openPicker(); });",
    "      return;",
    "    }",
    "    if (Date.now() > deadline) {",
    "      clearInterval(iv);",
    "      setStatus('Drive Picker scripts failed to load (apis.google.com blocked?)', 'error');",
    "    }",
    "  }, 100);",
    "  function openPicker() {",
    "    setStatus('Opening Picker…');",
    "    var picker = window.google && window.google.picker;",
    "    if (!picker) { setStatus('Picker namespace not available', 'error'); return; }",
    "    var view = new picker.DocsView(picker.ViewId.DOCUMENTS)",
    "      .setMimeTypes('application/vnd.google-apps.document')",
    "      .setMode(picker.DocsViewMode.LIST);",
    "    var built = new picker.PickerBuilder()",
    "      .setOAuthToken(accessToken)",
    "      .setDeveloperKey(apiKey)",
    "      .setAppId(projectNumber)",
    "      .addView(view)",
    "      .setTitle('Pick a Doc to track with Margin')",
    "      .setCallback(function (data) { onPicked(data); })",
    "      .build();",
    "    built.setVisible(true);",
    "  }",
    "  function onPicked(data) {",
    "    var picker = window.google.picker;",
    "    if (data.action === picker.Action.CANCEL) { setStatus('Cancelled. You can close this tab.'); closeSoon(); return; }",
    "    if (data.action !== picker.Action.PICKED) return;",
    "    var docs = data.docs || [];",
    "    var doc = docs[0];",
    "    if (!doc || !doc.id) { setStatus('No doc selected.', 'error'); return; }",
    "    setStatus('Registering with Margin…');",
    "    register(doc.id, doc.name || '');",
    "  }",
    "  function register(pickedId, _name) {",
    "    fetch('/api/picker/register-doc', {",
    "      method: 'POST',",
    "      credentials: 'include',",
    "      headers: { 'content-type': 'application/json' },",
    "      body: JSON.stringify({ docUrlOrId: pickedId }),",
    "    }).then(function (r) {",
    "      return r.text().then(function (t) {",
    "        var body = null; try { body = t ? JSON.parse(t) : null; } catch (_) {}",
    "        return { ok: r.ok, status: r.status, body: body };",
    "      });",
    "    }).then(function (res) {",
    "      var dup = res.status === 409 && res.body && res.body.error === 'already_exists';",
    "      if (res.ok || dup) {",
    "        setStatus(dup ? 'Doc was already tracked. You can close this tab.' : 'Doc tracked. You can close this tab.');",
    "        closeSoon();",
    "        return;",
    "      }",
    "      var msg = (res.body && (res.body.message || res.body.error)) || ('HTTP ' + res.status);",
    "      setStatus('Could not register doc: ' + msg, 'error');",
    "    }).catch(function (err) {",
    "      setStatus('Network error: ' + (err && err.message ? err.message : String(err)), 'error');",
    "    });",
    "  }",
    "})();",
  ].join("\n");
}

export function renderPickerHtml(script: string): string {
  return renderHashedScriptHtml({
    title: "Margin — Pick a Doc",
    bodyMarkup: `<h1>Margin</h1>\n<p id="status">Loading Picker…</p>`,
    externalScriptSrcs: ["https://apis.google.com/js/api.js"],
    inlineScript: script,
  });
}

export function renderNotSignedInHtml(): string {
  return renderStaticPageHtml(
    "Margin — Sign in first",
    `<h1>Margin</h1>
<p>You need to sign in before picking a Doc. Open the Margin extension and click <em>Sign in with Google</em>, then re-launch the Picker.</p>`,
  );
}

export function renderNotConfiguredHtml(): string {
  return renderStaticPageHtml(
    "Margin — Picker not configured",
    `<h1>Margin</h1>
<p>The Drive Picker is not configured on this server. The operator needs to set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_API_KEY</code>, and <code>GOOGLE_PROJECT_NUMBER</code>.</p>`,
  );
}

export function renderTokenErrorHtml(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
  }[c] ?? c));
  return renderStaticPageHtml(
    "Margin — Token error",
    `<h1>Margin</h1>
<p>Could not mint a Drive access token. Try signing out from the extension's Options page and signing in again.</p>
<p><code>${safe}</code></p>`,
  );
}

export function htmlErrorResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'",
    },
  });
}
