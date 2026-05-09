import { config } from "../config.ts";

/**
 * Drive Picker host page (SPEC §9.2 / §6.3).
 *
 * The Picker iframe is the only way to grant the Docket OAuth client
 * `drive.file` access to a Doc the user already owns — typing a URL into
 * Slack or the extension popup isn't enough. This route serves the page
 * that mounts that iframe.
 *
 * Flow on the page:
 *   1. Read the user's API token from `location.hash` (`#token=dkt_…`,
 *      optionally followed by `&suggestedDocId=…&suggestedTitle=…`). The
 *      token is hash-encoded (not query) so it never reaches access logs.
 *   2. GIS `initTokenClient({ scope: 'drive.file' })` mints an access
 *      token for the live Google session. The Picker uses that token to
 *      both render its file-list and record the per-file grant.
 *   3. On `PICKED`, POST `{ docUrlOrId }` to `/api/picker/register-doc`
 *      with the API token. Render the resulting project id (or
 *      "already tracked").
 *
 * The same client logic is structured so the extension can later host it
 * directly inside its own popup; the page is the web fallback.
 */
export function handlePickerHost(_req: Request): Response {
  return new Response(renderHtml(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderHtml(): string {
  const clientId = config.google.clientId;
  const apiKey = config.google.apiKey;
  const projectNumber = config.google.projectNumber;

  // Build the runtime config object inline. Values are JSON-stringified so a
  // missing API key surfaces as `null` to the client (which then renders an
  // explanatory error) instead of breaking the page.
  const runtime = JSON.stringify({
    clientId,
    apiKey,
    projectNumber,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Docket — pick a Google Doc</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.5 system-ui, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
    h1 { font-size: 18px; margin: 0 0 0.5rem; }
    p { margin: 0.5rem 0; }
    button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; border: 1px solid #888; background: #fff; border-radius: 6px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    code { background: #f1f1f1; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .banner { background: #eef6ff; border: 1px solid #c8dcff; border-radius: 6px; padding: 0.75rem 1rem; margin: 1rem 0; }
    .err { color: #b00020; }
    .ok { color: #0a7d2c; }
    input[type="text"] { font: inherit; width: 100%; padding: 0.4rem 0.5rem; border: 1px solid #aaa; border-radius: 4px; box-sizing: border-box; }
    label { display: block; font-weight: 600; margin-top: 0.75rem; }
    .row { margin: 0.75rem 0; }
    @media (prefers-color-scheme: dark) {
      body { color: #e6edf3; background: #0d1117; }
      button { background: #1e2429; color: #e6edf3; border-color: #555; }
      code { background: #1e2429; }
      .banner { background: #1c2733; border-color: #2a3a52; }
      input[type="text"] { background: #0d1117; color: #e6edf3; border-color: #444; }
    }
  </style>
</head>
<body>
  <h1>Pick a Google Doc to track with Docket</h1>
  <p>This grants the Docket OAuth client <code>drive.file</code> access to the doc you select.</p>

  <div id="banner" class="banner" hidden></div>
  <div id="status"></div>

  <div class="row">
    <label for="token">API token</label>
    <input id="token" type="text" autocomplete="off" placeholder="dkt_…" />
    <p style="font-size: 12px; opacity: 0.8;">Pre-filled from <code>#token=…</code> in the URL when launched from the extension.</p>
  </div>

  <p>
    <button id="open" disabled>Open Drive Picker</button>
  </p>

  <script>window.__DOCKET_PICKER__ = ${runtime};</script>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script src="https://apis.google.com/js/api.js" async defer></script>
  <script>
${PICKER_CLIENT_JS}
  </script>
</body>
</html>
`;
}

/**
 * Picker client logic. Inlined as a string so the route stays one file
 * with no separate static-asset pipeline. Uses GIS for the access-token
 * grant and gapi.load('picker') for the Picker iframe.
 *
 * Inputs read at runtime:
 *   window.__DOCKET_PICKER__ = { clientId, apiKey, projectNumber }
 *   location.hash = "#token=dkt_…&suggestedDocId=…&suggestedTitle=…"
 */
const PICKER_CLIENT_JS = `
const cfg = window.__DOCKET_PICKER__;
const statusEl = document.getElementById("status");
const bannerEl = document.getElementById("banner");
const tokenInput = document.getElementById("token");
const openBtn = document.getElementById("open");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

function readHash() {
  const out = { token: "", suggestedDocId: "", suggestedTitle: "" };
  if (!location.hash || location.hash.length < 2) return out;
  const params = new URLSearchParams(location.hash.slice(1));
  out.token = params.get("token") || "";
  out.suggestedDocId = params.get("suggestedDocId") || "";
  out.suggestedTitle = params.get("suggestedTitle") || "";
  return out;
}

const fromHash = readHash();
if (fromHash.token) {
  tokenInput.value = fromHash.token;
  // Drop the secret from the address bar so it doesn't end up in browser
  // history / referer headers.
  history.replaceState(null, "", location.pathname + location.search);
}
if (fromHash.suggestedTitle) {
  bannerEl.hidden = false;
  bannerEl.textContent = "Authorizing: " + fromHash.suggestedTitle;
}

if (!cfg.clientId || !cfg.apiKey || !cfg.projectNumber) {
  setStatus(
    "Picker is not configured on this server. Operator: set GOOGLE_API_KEY and GOOGLE_PROJECT_NUMBER.",
    "err"
  );
} else {
  // Both gapi.js and gsi.js load async; wait for both before enabling the button.
  let gapiReady = false;
  let gsiReady = false;
  const maybeEnable = () => {
    if (gapiReady && gsiReady && tokenInput.value.trim().length > 0) {
      openBtn.disabled = false;
    }
  };
  tokenInput.addEventListener("input", maybeEnable);

  const gapiCheck = setInterval(() => {
    if (window.gapi) {
      clearInterval(gapiCheck);
      gapi.load("picker", () => { gapiReady = true; maybeEnable(); });
    }
  }, 100);
  const gsiCheck = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(gsiCheck);
      gsiReady = true;
      maybeEnable();
    }
  }, 100);

  openBtn.addEventListener("click", () => {
    const apiToken = tokenInput.value.trim();
    if (!apiToken) {
      setStatus("Enter your Docket API token first.", "err");
      return;
    }
    setStatus("Requesting Google access token…");
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (tokenResp) => {
        if (tokenResp.error) {
          setStatus("Google sign-in failed: " + tokenResp.error, "err");
          return;
        }
        showPicker(tokenResp.access_token, apiToken);
      },
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

function showPicker(oauthToken, apiToken) {
  setStatus("Opening Picker…");
  const view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
    .setMimeTypes("application/vnd.google-apps.document")
    .setOwnedByMe(true)
    .setMode(google.picker.DocsViewMode.LIST);
  if (fromHash.suggestedTitle) view.setQuery(fromHash.suggestedTitle);

  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(oauthToken)
    .setDeveloperKey(cfg.apiKey)
    .setAppId(cfg.projectNumber)
    .addView(view)
    .setTitle("Pick a Doc to track with Docket")
    .setCallback((data) => onPicked(data, apiToken))
    .build();
  picker.setVisible(true);
}

async function onPicked(data, apiToken) {
  if (data.action === google.picker.Action.CANCEL) {
    setStatus("Cancelled.", "");
    return;
  }
  if (data.action !== google.picker.Action.PICKED) return;
  const doc = (data.docs || [])[0];
  if (!doc || !doc.id) {
    setStatus("No doc selected.", "err");
    return;
  }
  if (fromHash.suggestedDocId && doc.id !== fromHash.suggestedDocId) {
    setStatus(
      "Heads-up: you picked a different doc (" + doc.name + ") than the one you were on. Continuing.",
      ""
    );
  }
  setStatus("Registering doc with Docket…");
  try {
    const res = await fetch("/api/picker/register-doc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + apiToken,
      },
      body: JSON.stringify({ docUrlOrId: doc.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setStatus("Tracked. Project " + body.projectId + ". You can close this tab.", "ok");
    } else if (res.status === 409 && body.error === "already_exists") {
      setStatus("Already tracked. Project " + body.projectId + ". You can close this tab.", "ok");
    } else if (res.status === 401) {
      setStatus("API token rejected. Issue a new one with 'bun docket token issue'.", "err");
    } else {
      setStatus("Failed to register: " + (body.message || res.status), "err");
    }
  } catch (err) {
    setStatus("Network error: " + err, "err");
  }
}
`;
