# Docket browser extension

MV3 extension for Chrome / Edge / Firefox. **Capture role only** at this
phase — see [`SPEC.md` §6.4](../../SPEC.md#64-browser-extension). Watches the
Google Docs discussion sidebar for replies typed into a *suggestion*'s sidebar
entry (the public Drive/Docs APIs don't expose those — verified empirically;
see [`SPEC.md` §11](../../SPEC.md#11-out-of-scope-for-v1)) and POSTs them to
the Docket backend.

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

`src/content/sidebar-scraper.ts` keeps every selector in module-scope
constants (`THREAD_ROOT_SELECTORS`, `REPLY_SELECTORS`, etc.). When Docs
reships:

1. Open a doc with suggestion-thread replies and inspect the sidebar.
2. Identify the new attributes (`docos-anchor-…` ids,
   `data-discussion-id`, etc.).
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
      popup.{html,css,ts}   queue size + flush button
    shared/
      browser.ts            chrome / browser API shim
      messages.ts           typed runtime messages
      storage.ts            typed chrome.storage wrappers
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
