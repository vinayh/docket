import { auth } from "../auth/server.ts";
import { config } from "../config.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";

/**
 * GET /api/picker/page
 *
 * Backend-hosted Drive Picker. The same Google `origin_mismatch` policy
 * that killed `chrome.identity.launchWebAuthFlow` (extension-origin sign-in,
 * see `handleAuthExtSuccess`) also rejects `docs.google.com/picker`'s
 * iframe parent when it's `chrome-extension://<id>/...` — the OAuth
 * client's authorized JavaScript origins can't include that scheme. The
 * fix is to host the Picker page on the backend's own origin (which is
 * already in the OAuth client allow-list because sign-in runs there too).
 *
 * Auth: Better Auth session cookie — the user reached this tab from the
 * extension popup *after* completing sign-in via `/api/auth/ext/launch-tab`,
 * so the cookie is on the same origin. No bearer here; the page is a
 * top-level navigation, not a CORS XHR.
 *
 * Inlined into the page body (all from trusted sources):
 *   - the Drive Picker dev-key + app-id + client id (`/picker/config`'s
 *     payload — not secrets)
 *   - a freshly-minted Drive `access_token` via `tokenProviderForUser`,
 *     so the Picker skips GIS entirely (`accounts.google.com` chokes the
 *     same way it does on extension origins for the in-popup sandbox).
 *
 * On pick the page POSTs to `/api/picker/register-doc` (same-origin, so the
 * session cookie rides along) and shows a "tracked — close this tab"
 * message. Reopening the popup on the original Docs tab picks up the
 * tracked state via `doc/state`; no cross-surface message bus needed.
 *
 * CSP: hashed inline script + `https://apis.google.com` for the gapi
 * loader, `docs.google.com` / `content.googleapis.com` for the Picker
 * iframe, and `'self' https://*.googleapis.com` in `connect-src` for the
 * Picker's REST calls plus our register-doc POST.
 */
export async function handlePickerPage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const docIdHint = url.searchParams.get("docId") ?? "";

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return htmlResponse(renderNotSignedInHtml(), { status: 401 });
  }

  // `clientId` is the only `required()` getter; the other two are
  // `optional()` and degrade to null. Treat any missing as "not
  // configured" rather than 500-ing.
  let clientId: string | null = null;
  try {
    clientId = config.google.clientId;
  } catch {
    clientId = null;
  }
  const apiKey = config.google.apiKey;
  const projectNumber = config.google.projectNumber;
  if (!clientId || !apiKey || !projectNumber) {
    return htmlResponse(renderNotConfiguredHtml(), { status: 500 });
  }

  let accessToken: string;
  try {
    accessToken = await tokenProviderForUser(session.user.id).getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlResponse(renderTokenErrorHtml(msg), { status: 500 });
  }

  const script = buildPickerScript({
    clientId,
    apiKey,
    projectNumber,
    accessToken,
    docIdHint,
  });
  const scriptHash = await sha256Base64(script);
  const html = renderPickerHtml(script);

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'sha256-${scriptHash}' https://apis.google.com`,
        "style-src 'unsafe-inline'",
        "connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com",
        "frame-src https://docs.google.com https://content.googleapis.com",
        "img-src 'self' data: https:",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

interface ScriptInputs {
  clientId: string;
  apiKey: string;
  projectNumber: string;
  accessToken: string;
  docIdHint: string;
}

function buildPickerScript(v: ScriptInputs): string {
  // JSON.stringify gives a JS-safe string literal: it escapes quotes,
  // newlines, and the dangerous `</script>` separators. The clientId is
  // unused inside the Picker call itself (Picker doesn't take a clientId)
  // but we inline it so the operator sees a single set of Picker values
  // here — matches the existing `/picker/config` payload.
  const apiKey = JSON.stringify(v.apiKey);
  const projectNumber = JSON.stringify(v.projectNumber);
  const accessToken = JSON.stringify(v.accessToken);
  const _docIdHint = JSON.stringify(v.docIdHint);
  // We deliberately *don't* `setQuery(docIdHint)` — Picker's title
  // tokenizer ANDs whitespace-split tokens and real Doc titles routinely
  // contain `[brackets]` / `:` / punctuation that defeat it. The hint is
  // inlined for future use (e.g. select-and-confirm UX) but not consumed.
  return [
    "(function () {",
    `  var apiKey = ${apiKey};`,
    `  var projectNumber = ${projectNumber};`,
    `  var accessToken = ${accessToken};`,
    `  var docIdHint = ${_docIdHint}; void docIdHint;`,
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

function renderPickerHtml(script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<base target="_self">
<title>Margin — Pick a Doc</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 36rem; color: #222; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #444; }
  p[data-tone="error"] { color: #b35900; }
</style>
</head>
<body>
<h1>Margin</h1>
<p id="status">Loading Picker…</p>
<script src="https://apis.google.com/js/api.js" async defer></script>
<script>${script}</script>
</body>
</html>`;
}

function renderNotSignedInHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Margin — Sign in first</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; color: #222; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #444; }
</style>
</head>
<body>
<h1>Margin</h1>
<p>You need to sign in before picking a Doc. Open the Margin extension and click <em>Sign in with Google</em>, then re-launch the Picker.</p>
</body>
</html>`;
}

function renderNotConfiguredHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Margin — Picker not configured</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; color: #222; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #444; }
</style>
</head>
<body>
<h1>Margin</h1>
<p>The Drive Picker is not configured on this server. The operator needs to set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_API_KEY</code>, and <code>GOOGLE_PROJECT_NUMBER</code>.</p>
</body>
</html>`;
}

function renderTokenErrorHtml(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
  }[c] ?? c));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Margin — Token error</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; color: #222; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #444; }
  code { background: #f6f8fa; padding: 0 .3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>Margin</h1>
<p>Could not mint a Drive access token. Try signing out from the extension's Options page and signing in again.</p>
<p><code>${safe}</code></p>
</body>
</html>`;
}

function htmlResponse(body: string, init: { status: number }): Response {
  return new Response(body, {
    status: init.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

async function sha256Base64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let bin = "";
  const view = new Uint8Array(hash);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin);
}
