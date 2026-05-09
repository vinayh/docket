# Docket browser extension

MV3 extension for Chrome / Edge / Firefox. **Phase-2 scope** — see
[`SPEC.md` §6.4](../../SPEC.md#64-browser-extension):

- **Capture role.** Watches the Google Docs discussion sidebar for replies
  typed into a *suggestion*'s sidebar entry (the public Drive/Docs APIs
  don't expose those — verified empirically;
  see [`SPEC.md` §11](../../SPEC.md#11-out-of-scope-for-v1)) and POSTs them
  to the Docket backend.
- **"Track this doc" popup.** When the active tab is a Google Doc, the
  toolbar popup surfaces a button that opens the backend's hosted Drive
  Picker with the open doc's id + DOM-scraped name as hints — the
  per-file `drive.file` grant flow (SPEC §9.2). Picking the doc registers
  it as a project on the backend.

The rich-UI role (dashboards, diff viewer, reconciliation, overlay editor)
lands in Phase 4. The visualization role (in-canvas highlights, gutter
markers, selection capture) lands in Phase 6.

## Build

```sh
bun run surfaces/extension/build.ts                    # both targets
bun run surfaces/extension/build.ts --target=chromium  # one target
bun run surfaces/extension/build.ts --watch            # rebuild on change
```

Outputs to `surfaces/extension/dist/{chromium,firefox}/`. Each dist directory
is loadable directly:

- **Chrome / Edge:** `chrome://extensions` → enable Developer Mode → Load
  unpacked → pick `dist/chromium`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → pick any file inside `dist/firefox` (e.g. `manifest.json`).

## Configure

1. Issue an API token from the backend:

   ```sh
   bun docket token issue --user <email> --label "my laptop"
   ```

   The token is shown once; copy it.

2. Open the extension's options page. Enter:
   - Backend URL — typically `http://localhost:8787` for local dev or your
     Fly.io app URL in production.
   - API token — the value from step 1.

3. Click **Test connection** to confirm `/healthz` responds. Click **Save**.

The popup (toolbar icon) shows the queued-capture count and the last error,
if any. **Flush queue now** drains the queue immediately rather than waiting
for the 1-min alarm.

## How "Track this doc" works

The popup (`src/popup/popup.ts`) calls `chrome.tabs.query` for the active
tab. If the URL matches `docs.google.com/document/d/<id>`, it shows the
**Track this doc** row labeled with the doc's actual name (from the title
cache, see below). Clicking opens
`<backendUrl>/picker#token=…&suggestedDocId=…&suggestedTitle=…`
in a new tab; the Picker page POSTs to `/api/picker/register-doc` after the
user picks the file. No `tabs` permission is needed because the manifest's
`host_permissions: ["https://docs.google.com/*"]` already covers Docs tabs.

The doc title comes from the **title cache** populated by the content
script. Each scan calls `setDocTitle(docId, name)` (`shared/storage.ts`)
with the value read from the title input — see `DOC_NAME_SELECTORS` in
`docs-content.ts`. We don't use `tab.title` because Chrome localizes it
(e.g. "<name> - Google Docs", or its translation), and the suffix tokens
break Picker's token-AND `setQuery` matching against file names.

## How capture works

`src/content/docs-content.ts` runs on `https://docs.google.com/document/*`. A
`MutationObserver` (debounced at 750 ms) re-scans the discussion sidebar after
DOM activity settles. `sidebar-scraper.ts` walks the sidebar with a tolerant
selector list — Google Docs reships the comment UI roughly quarterly, and
selectors **will** rot. The scraper's contract is "best-effort, fail
silently, surface what we can"; broken selectors mean missing captures, not
crashes.

For each suggestion thread it finds, every visible reply (including the seed
comment) is normalized into a `CaptureInput`:

```ts
{
  externalId: "<sha256(kixId, author, ts, body)>",  // idempotency key
  docId: "...",
  kixDiscussionId: "kix.<n>",                       // when present in DOM
  parentQuotedText: "...",                          // suggestion's quoted text
  authorDisplayName: "...",
  createdAt: "<ISO-8601 if parsed>",
  body: "<reply text>"
}
```

Captures are sent to the service worker, which:

1. De-duplicates against the per-doc seen-id set in `chrome.storage.local`.
2. Persists survivors to a queue (also in `chrome.storage.local`).
3. POSTs batches of ≤25 to `POST /api/extension/captures` on the configured
   backend.
4. On 2xx, marks the externalIds as seen so they aren't retried.
5. On network / 5xx, leaves the queue intact; a `chrome.alarms` tick every
   60 s retries.
6. On 401 / 403, surfaces the error in the popup and pauses retries until
   settings change.

Idempotency is end-to-end: the backend dedupes on `(version_id, external_id)`
in the `canonical_comment` table, so even a corrupted seen-id cache won't
duplicate rows.

## DOM selector maintenance

Two selector lists, both module-scope constants, both prone to rot when
Docs reships (~quarterly):

- `src/content/sidebar-scraper.ts` — `THREAD_ROOT_SELECTORS`,
  `REPLY_SELECTORS`, etc., for the discussion sidebar.
- `src/content/docs-content.ts` — `DOC_NAME_SELECTORS`, for the title input
  used by the "Track this doc" popup label and Picker query.

When Docs reships:

1. Open a doc with suggestion-thread replies and inspect the sidebar /
   title input.
2. Identify the new attributes / classes.
3. Add new selectors to the head of the relevant array — older selectors
   stay so older Docs builds still parse.
4. Run `bun run surfaces/extension/build.ts` and reload the unpacked
   extension.

Budget: ~4–8 hours / month per
[`SPEC.md` §6.4](../../SPEC.md#64-browser-extension).

## Layout

```
surfaces/extension/
  manifest.chromium.json    Chrome / Edge MV3 manifest
  manifest.firefox.json     Firefox MV3 manifest (gecko id, strict_min_version)
  build.ts                  Bun.build pipeline → dist/{chromium,firefox}/
  tsconfig.json             extends root; adds DOM + chrome types
  src/
    background/
      service-worker.ts     queue + flush + alarm tick
    content/
      docs-content.ts       MutationObserver bootstrap
      sidebar-scraper.ts    DOM heuristics (tolerant selector list)
      ids.ts                docId parser + stable reply id hash
    options/
      options.{html,css,ts} backend URL + API token
    popup/
      popup.{html,css,ts}   queue size + flush button + "Track this doc"
    shared/
      browser.ts            chrome / browser API shim
      messages.ts           typed runtime messages
      storage.ts            typed chrome.storage wrappers (settings, queue, doc-title cache)
      types.ts              CaptureInput wire format
  static/icons/             real artwork goes here (see build.ts placeholder)
  dist/                     build output, .gitignored
```

## Out of scope (yet)

- In-canvas highlights / gutter markers — Phase 6, requires the
  accessibility-DOM mirror or selection-event hooks ([`SPEC.md` §9.6](../../SPEC.md#96-canvas-rendered-doc-body)).
- Project dashboard, diff viewer, reconciliation UI, overlay editor —
  Phase 4.
- Mobile / iPad Docs — browser extensions don't run on those clients.
