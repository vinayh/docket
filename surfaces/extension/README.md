# Margin browser extension

MV3 extension for Chrome / Edge / Firefox. **Phase-4 scope** — see
[`SPEC.md` §6.4](../../SPEC.md#64-browser-extension):

- **Project surface (popup).** State machine driven by the active Docs
  tab: configure backend → sign in → open a Doc → "Add to Margin"
  (opens the backend-hosted Drive Picker in a new tab) → tracked view
  with role / version / comment count / last-synced / "Sync now". All
  backend calls flow through the service worker; the session token
  never touches the popup.
- **Rich UI (side panel).** Preact app — project dashboard (versions,
  derivatives, review history, reviewer participation), structured
  side-by-side version diff, comment reconciliation view.

In-canvas highlights / gutter markers / selection capture land in
Phase 6. Comment ingest is **not** an extension concern — it lives in
the backend (`.docx` export, SPEC §9.8).

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

1. Open the extension's Options page. Enter the **Backend URL**
   (`http://localhost:8787` for local dev, or your Fly.io app URL in
   production), click **Test connection** to confirm `/healthz` responds
   (Chrome will prompt for the backend origin — approve it), then
   **Save backend URL**.

2. Click **Sign in with Google**. The Options page opens a top-level
   tab at `/api/auth/ext/launch-tab`. Better Auth runs the Google
   consent flow, lands on the `/api/auth/ext/success` bridge page, and
   the bridge hands the session token to the SW (Chromium:
   `chrome.runtime.sendMessage`; Firefox fallback: `location.hash`,
   picked up by the SW's `tabs.onUpdated` listener). The SW persists
   it under `chrome.storage.local.settings.sessionToken`; the Options
   page's `chrome.storage.onChanged` listener flips the UI to
   "Signed in" without a reload.

The popup is the primary project surface. A `<details>` diagnostics panel
at the bottom of every view shows the current `/healthz` reachability
status.

## How the popup project surface works

The popup (`entrypoints/popup/Popup.tsx`) is a Preact state machine over a
single `View` discriminated union. `boot()` drives the transitions:

1. **No settings** → options page nudge.
2. **No Doc tab** → muted "open a Google Doc."
3. Active Docs tab → SW `doc/state` (`POST /api/extension/doc-state`).
4. **Untracked** → "Add to Margin" opens `${backendUrl}/api/picker/page`
   in a new tab; the popup closes. The user picks a Doc; the page
   POSTs to `/api/picker/register-doc` via the session cookie and
   auto-closes with a "tracked" message.
5. User returns to the Docs tab and re-opens the extension → fresh
   `doc/state` call lands in the **Tracked** view (role, version label,
   comment count, last-synced, "Sync now"). "Sync now" calls SW `doc/sync`
   (`POST /api/extension/doc-sync`), which re-runs `ingestVersionComments`
   and returns refreshed state.

Every backend call routes through the SW, which adds
`Authorization: Bearer <sessionToken>` from `chrome.storage.local`. The
Picker page uses the session cookie set by Better Auth on sign-in —
same-origin with `/api/picker/register-doc`, so no bearer token leaves
the extension surface.

## Toolbar-icon routing

For Doc tabs that already belong to a project, clicking the toolbar
icon opens the **side-panel dashboard** directly instead of the popup.
The SW watches `tabs.onActivated` / `tabs.onUpdated`, calls
`doc/state` (cached briefly per `docId`), and toggles the per-tab
popup: `action.setPopup({ tabId, popup: "" })` for tracked Docs (so
`action.onClicked` fires and opens the side panel),
`popup: "popup.html"` for everything else (non-Doc tabs, untracked
Docs, signed-out state — the popup's existing state machine handles
those). The cache is invalidated on settings change (sign-in /
sign-out) and on `doc/sync` / `doc/register` flips.

There is no static `host_permissions` for `docs.google.com` — the
extension never injects into the Docs tab. The `tabs` API gives the popup
read access to the active tab's URL + title without any extra permission.

## Doc title

The popup reads `tab.title` via `chrome.tabs.query({ active: true })` and
passes it through `cleanDocTitle()` in `utils/ids.ts`, which strips the
trailing locale `" - Google Docs"` suffix Chrome puts on
`document.title`. The cleaned name is the popup heading.

## Layout

```
surfaces/extension/
  wxt.config.ts             one config, per-browser manifest via (env) callback
  tsconfig.json             extends .wxt/tsconfig.json + DOM + WebWorker libs
  entrypoints/
    background.ts           defineBackground — message router → backend POSTs.
                            Also hosts the onMessageExternal listener that
                            accepts the auth/token payload from the
                            /api/auth/ext/success bridge page.
    options/
      index.html            includes meta name="manifest.open_in_tab" content="true"
      main.ts               backend URL form + Sign-in / Sign-out controls
      style.css
    popup/
      index.html            mounts <Popup/> via main.tsx
      main.tsx              Preact bootstrap
      Popup.tsx             View discriminated union + async flows
      Header.tsx            shared title row
      Diagnostics.tsx       /healthz probe <details> panel
      views/                NoSettings, NeedsSignIn, NoDoc, Untracked,
                            Tracked, ErrorView
      style.css
    sidepanel/              Preact rich UI — dashboard, diff, reconciliation
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
