# Margin browser extension

MV3 extension for Chrome / Edge / Firefox. **Phase-4 scope** — see
[`SPEC.md` §6.4](../../SPEC.md#64-browser-extension):

- **Project surface (popup).** Opens to a state machine driven by the
  active Docs tab: configure backend → open a Doc → "Add to Margin" (in-popup
  sandboxed Drive Picker on Chromium, fallback `/picker` tab on Firefox)
  → tracked view with role / version / comment count / last-synced /
  "Sync now". All backend calls flow through the service worker so the
  API token never touches the popup origin or the picker sandbox.
- **Rich UI (side panel).** Preact app — project dashboard (versions,
  derivatives, review history, reviewer participation), structured
  side-by-side version diff, comment reconciliation view.

The visualization role (in-canvas highlights, gutter markers, selection
capture) lands in Phase 6. Comment ingest is **not** an extension
concern — it lives in the backend (`.docx` export, SPEC §9.8).

## Build

[WXT](https://wxt.dev) drives the build (Vite under the hood). Scripts live
in the repo root `package.json`:

```sh
bun run ext:build              # production build, Chrome/Edge target
bun run ext:build:firefox      # production build, Firefox target
bun run ext:dev                # dev server with HMR (Chrome/Edge)
bun run ext:dev:firefox        # dev server with HMR (Firefox)
bun run ext:zip                # bundle dist/<target>/ into a publishable .zip
```

Outputs to `surfaces/extension/dist/{chrome-mv3,firefox-mv3}/`. Each
output directory is loadable directly:

- **Chrome / Edge:** `chrome://extensions` → enable Developer Mode → Load
  unpacked → pick `dist/chrome-mv3`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → pick any file inside `dist/firefox-mv3` (e.g. `manifest.json`).

## Configure

1. Issue an API token from the backend:

   ```sh
   bun margin token issue --user <email> --label "my laptop"
   ```

   The token is shown once; copy it.

2. Open the extension's options page. Enter:
   - Backend URL — typically `http://localhost:8787` for local dev or your
     Fly.io app URL in production.
   - API token — the value from step 1.

3. Click **Test connection** to confirm `/healthz` responds. Click **Save**.

The popup is the primary project surface. A `<details>` diagnostics panel
at the bottom of every view shows the current `/healthz` reachability
status.

## How the popup project surface works

The popup (`entrypoints/popup/Popup.tsx`) is a Preact state machine over a
single `View` discriminated union. `boot()` drives the transitions:

1. **No settings** → options page nudge.
2. **No Doc tab** → muted "open a Google Doc."
3. Active Docs tab → SW `doc/state` (`POST /api/extension/doc-state`).
4. **Untracked** → "Add to Margin" → on Chromium, `<PickerOverlay/>`
   mounts the sandboxed Picker iframe inside the popup. On Firefox MV3
   (no `sandbox.pages` support), the popup detects the UA and opens
   `<backendUrl>/picker#token=…&suggestedDocId=…&suggestedTitle=…` in a
   new tab as fallback.
5. After pick → SW `doc/register` (`POST /api/picker/register-doc`) → re-fetch
   state → **Tracked** view (role, version label, comment count, last-synced,
   "Sync now"). "Sync now" calls SW `doc/sync` (`POST /api/extension/doc-sync`),
   which re-runs `ingestVersionComments` and returns refreshed state.

The popup never holds the API token: every backend call routes through the
service worker, which decorates requests with the configured bearer. The
sandboxed Picker runs at `null` origin and can't reach the backend at
all — it postMessages the picked doc id back to the popup, and the popup
(at the `chrome-extension://...` origin allow-listed in CORS) hits
`/api/picker/register-doc` via the SW.

There is no static `host_permissions` for `docs.google.com` — the
extension never injects into the Docs tab. The `tabs` API gives the popup
read access to the active tab's URL + title without any extra permission.

## Doc title

The popup reads `tab.title` via `chrome.tabs.query({ active: true })` and
passes it through `cleanDocTitle()` in `utils/ids.ts`, which strips the
trailing locale `" - Google Docs"` suffix Chrome puts on
`document.title`. The cleaned name powers both the popup heading and the
Drive Picker's `setQuery` name pre-filter (which uses token-AND matching,
so the suffix tokens would otherwise blow it up).

## Layout

```
surfaces/extension/
  wxt.config.ts             one config, per-browser manifest via (env) callback
  tsconfig.json             extends .wxt/tsconfig.json + DOM + WebWorker libs
  entrypoints/
    background.ts           defineBackground — message router → backend POSTs
    options/
      index.html            includes meta name="manifest.open_in_tab" content="true"
      main.ts               backend URL + API token form
      style.css
    popup/
      index.html            mounts <Popup/> via main.tsx
      main.tsx              Preact bootstrap
      Popup.tsx             View discriminated union + async flows
      Header.tsx            shared title row
      Diagnostics.tsx       /healthz probe <details> panel
      PickerOverlay.tsx     iframe lifecycle + postMessage handshake
      views/                NoSettings, NoDoc, Untracked, Tracked, ErrorView
      style.css
    sidepanel/              Preact rich UI — dashboard, diff, reconciliation
    picker-sandbox.sandbox/  WXT recognizes the .sandbox.html suffix and emits
      index.html             into the manifest's sandbox.pages (chromium only)
      main.ts                gapi / gsi loader + Picker postMessage host
      style.css
  utils/
    ids.ts                  docId parser + cleanDocTitle()
    messages.ts             typed runtime messages
    storage.ts              typed chrome.storage wrappers (settings only)
    types.ts                shared wire types (DocState, ProjectDetail, …)
  public/icons/             placeholder artwork — replace before publish
  dist/                     build output, gitignored
  .wxt/                     generated types (wxt prepare), gitignored
```

## Out of scope (yet)

- In-canvas highlights / gutter markers — Phase 6, requires the
  accessibility-DOM mirror or selection-event hooks ([`SPEC.md` §9.6](../../SPEC.md#96-canvas-rendered-doc-body)).
- Mobile / iPad Docs — browser extensions don't run on those clients.
