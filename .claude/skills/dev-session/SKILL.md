---
name: dev-session
description: Boot the Margin dev loop — backend on :8787 plus a Chrome session with the WXT-built extension loaded into the persistent test profile (`.margin-test-chrome/`). Use when the user asks to "launch a dev session", "start the dev rig", "open the extension in Chrome", or anything equivalent.
---

# Margin dev session

End state: `bun margin serve` running on :8787, the extension built into `surfaces/extension/dist/chrome-mv3/`, and Chrome running with the extension loaded into the persistent test profile so the popup / side panel / options pages can be poked.

## 1. Backend on :8787

Migrations don't apply at boot (see memory `project_serve_auto_migrate.md`), so always migrate first:

```bash
bun migrate
```

Then check whether the backend is already running before starting another one:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

If nothing's listening, launch via Bash with `run_in_background: true`:

```bash
bun margin serve
```

Capture the bash shell id from the Bash result. You'll want it for tailing logs later (BashOutput) and for shutting down (KillShell) if the user asks. Don't poll the process — if you need to wait, Monitor it.

## 2. Extension build

Rebuild every time — WXT is fast (~600 ms) and the alternative is debugging stale CSS:

```bash
bun run ext:build
```

The dist lives at `surfaces/extension/dist/chrome-mv3/` (absolute: `/Users/vinay/Dev/margin/surfaces/extension/dist/chrome-mv3`).

## 3. Chrome via chrome-devtools-mcp

`.mcp.json` at the repo root pre-wires the server with `--userDataDir=./.margin-test-chrome --channel=stable --ignoreDefaultChromeArg=--disable-extensions --categoryExtensions`. Don't try to pass `--load-extension` — it's silently ignored under Puppeteer-launched Chrome (per AGENTS.md). Use the MCP's own `install_extension` instead.

Calling any `mcp__chrome-devtools__*` tool boots Chrome. Start with `list_pages`, then inspect what's already loaded:

1. `mcp__chrome-devtools__list_pages` — boots Chrome and returns open tabs + extension SW IDs.
2. `mcp__chrome-devtools__list_extensions` — is "Margin" already installed in this profile?
   - **Yes** → `mcp__chrome-devtools__reload_extension` with the id from the list.
   - **No** → `mcp__chrome-devtools__install_extension` with `path: /Users/vinay/Dev/margin/surfaces/extension/dist/chrome-mv3`. Save the returned id.

## 4. Open whatever the user wants to look at

Surfaces map to extension URLs (substitute the extension id):

- Popup: `chrome-extension://<id>/popup.html`
- Side panel (standalone tab — works thanks to the `?activeDocId=` override in `App.tsx`): `chrome-extension://<id>/sidepanel.html`. Add `?activeDocId=<docId>` to pin a specific tracked doc.
- Options: `chrome-extension://<id>/options.html`

Use `mcp__chrome-devtools__new_page` with the URL, or `navigate_page` on the current tab.

For the popup's natural in-toolbar opening, `trigger_extension_action` with the extension id works.

## 5. Side-panel ↔ backend wiring

The side panel hits the backend via the SW, which reads `chrome.storage.local.settings.{backendUrl,sessionToken}`. The persistent profile is supposed to be pre-warmed with these. To verify or re-pin them, evaluate in the SW context:

```js
// inside mcp__chrome-devtools__evaluate_script with serviceWorkerId=<sw id>
async () => {
  const all = await chrome.storage.local.get(null);
  return { backendUrl: all.settings?.backendUrl, hasSessionToken: !!all.settings?.sessionToken };
}
```

If `sessionToken` is missing, the user has to sign in (Options page → Test connection → Save → Sign in via Google flow). Chrome rejects programmatic `permissions.request` outside a user gesture, so an automated grant of `http://localhost:8787/*` won't work — the user clicks Test connection manually.

## What to tell the user when you're done

One short line: backend pid + port, extension id, the URL of whatever surface you opened. No play-by-play.

## Don'ts

- Don't `cd` between commands — use absolute paths.
- Don't kill the existing backend if it's already running on :8787; reuse it.
- Don't run `--use-mock-keychain` off — it wipes the test account's cookies.
- Don't `rm -rf .margin-test-chrome/` to "fix" something; that profile is pre-warmed with the test Google account.
