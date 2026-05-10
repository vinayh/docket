# Docket — project conventions

Phased build plan in [`SPEC.md` §12](./SPEC.md#12-build-sequence) — each phase has a `Status:` line; keep those current as work lands.

## Repo layout

```
src/
  config.ts            lazy env-var getters; importing it doesn't require any env var
  db/
    schema.ts          12 tables from SPEC §4
    client.ts          drizzle + bun:sqlite (WAL, FK on)
    migrate.ts         applies generated migrations
  auth/
    encryption.ts      envelope encryption (KEK → per-row DEK → ciphertext)
    credentials.ts     TokenProvider with in-memory cache + auto-refresh
    connect.ts         completes OAuth: upserts user, stores encrypted refresh token
  google/              endpoint-shaped, typed wrappers (no domain logic here)
    oauth.ts           authorize URL, code exchange, refresh, userinfo
    api.ts             authedFetch / authedJson — refresh-on-401
    drive.ts           files.get / files.copy / comments.list / files.watch / permissions
    docs.ts            documents.get / documents.batchUpdate + op.* helpers
  domain/              business logic that composes db/google/auth (no HTTP, no CLI)
    google-doc-url.ts  parse doc IDs out of URLs
    project.ts         createProject / getProject / list*
    version.ts         createVersion (copies parent doc, hashes snapshot) / list / archive
    anchor.ts          buildAnchor (quoted text → paragraph hash + structural offset)
    reanchor.ts        reanchor (source CommentAnchor + target Document → confidence + status)
    suggestions.ts     extractSuggestions (Docs body → tracked-change spans)
    comments.ts        ingestVersionComments (Drive comments + suggestions → canonical_comment)
    project_comments.ts projectCommentsOntoVersion (run reanchor for every canonical comment)
    overlay.ts         overlay/op CRUD, planOverlay (pure), applyOverlayAsDerivative
    watcher.ts         drive.files.watch subscribe/unsubscribe/handle, polling fallback, renewer
    doc-state.ts       getDocState (docId+userId → tracked? role, project, version, lastSyncedAt, counts)
  cli/                 thin parse-and-call shells over src/domain/, via a single dispatcher
    index.ts           subcommand dispatcher (`bun docket <cmd>`)
    util.ts            shared helpers (default user, etc.)
    connect.ts         one-shot OAuth callback receiver
    doc.ts             doc create (Docs API documents.create, optional --seed)
    smoke.ts           end-to-end: getFile + copyFile + listComments
    inspect.ts         dump raw Drive/Docs API responses (verify what's exposed)
    project.ts         project create / list
    version.ts         version create / list
    comments.ts        comments ingest / list
    reanchor.ts        reanchor <target-version-id>
    overlay.ts         overlay create / list / add-op / ops / apply; derivative list
    watcher.ts         watcher subscribe / list / unsubscribe / renew / poll / simulate
    serve.ts           start the HTTP API (`bun docket serve [--port <n>]`)
    token.ts           issue / list / revoke per-user API tokens
  auth/
    api-token.ts       opaque per-user tokens (sha256 hashed at rest)
  api/                 Bun.serve HTTP host
    server.ts          route table + in-process renew/poll loops; dispatches to per-route modules
    oauth.ts           OAuth start + callback handlers (in-memory state store)
    middleware.ts      bearer auth + JSON response helpers
    cors.ts            permissive CORS for cross-origin routes (extension + localhost)
    extension.ts       POST /api/extension/captures (browser-extension ingest)
    doc-state.ts       POST /api/extension/doc-state (popup project surface — tracked? state)
    doc-sync.ts        POST /api/extension/doc-sync (popup "Sync now" — re-poll comments + return state)
    drive-webhook.ts   POST /webhooks/drive (drive.files.watch push receiver)
    picker.ts          GET /picker (Drive Picker host page; needs GOOGLE_API_KEY + GOOGLE_PROJECT_NUMBER)
    picker-config.ts   GET /api/picker/config (public — Picker runtime config for the in-popup sandboxed Picker)
    picker-register.ts POST /api/picker/register-doc (post-pick project registration)
  domain/
    capture.ts         resolve scraped sidebar replies → canonical_comment
  surfaces/            Slack bot / Workspace add-on / browser extension
    extension/         MV3 capture-role extension (Chrome / Edge / Firefox)
drizzle/               generated migration SQL
Dockerfile             multi-stage Bun-on-Alpine image; runs migrate then serve
fly.toml               Fly.io app config (see README §"Deployment")
.github/workflows/     CI: codecov upload + fly-deploy (typecheck/test gate → flyctl deploy)
```

- **Surface** = user-facing UX. **Client** = any other API caller. Per SPEC §3, all state lives in the backend; surfaces are views.
- Don't put logic in `src/cli/`.

## CLI

- Single dispatcher: `bun docket <subcommand>` (`src/cli/index.ts`).
- Each subcommand exports `async function run(args: string[])` and is registered in `index.ts`.
- Subcommands with multiple verbs (`comments {ingest,list}`, `watcher {subscribe,...}`) use `dispatchSubcommands(args, USAGE, table)` from `cli/util.ts` rather than hand-rolling the `if (sub === ...) {}` chain.
- Use `parseArgs` from `node:util`.
- Exit codes: `usage(text)` exits 2 (Unix convention for misuse); `fatal(text)` exits 1 (runtime failure). `die` is a deprecated alias for `fatal`.

## Domain conventions

- **Not-found pairs.** Each domain entity has a nullable getter (`getProject`, `getVersion`, `getOverlay`, `getUserByEmail`, `firstUser`) and a throwing partner (`requireProject`, `requireVersion`, `requireOverlay`, `requireUserByEmail`, `requireFirstUser`). Most call sites want the throwing variant — reach for the nullable one only when "missing" is a normal branch (e.g. "is this doc already a project?"). Don't inline `(await db.select()…)[0]; if (!x) throw …` — use the helper.
- **Token-provider sugar.** Sites whose only reason to fetch a project is to get the owner's `userId` should call `tokenProviderForProject(projectId)`. Sites that need other project fields call `requireProject` and pass `proj.ownerUserId` to `tokenProviderForUser` themselves.

## HTTP API

- `bun docket serve [--port <n>]` runs the API host (`Bun.serve`, in `src/api/server.ts`). In production, the Fly container runs the same command; `PORT` and `DOCKET_DB_PATH` are set via `fly.toml`, secrets via `flyctl secrets set`.
- Routes live in `src/api/`. The server keeps a route table — register new routes there, not by branching `pathname` inline.
- Public routes today: `/healthz`, `/oauth/start`, `/oauth/callback`, `/picker` (real Drive Picker host page — needs `GOOGLE_API_KEY` + `GOOGLE_PROJECT_NUMBER`; renders a friendly error otherwise).
- Webhooks: `POST /webhooks/drive` (Drive `files.watch` push receiver). Always responds 200 OK so Google stops retrying — channel-level errors get logged.
- Bearer-authenticated API surface: anything under `/api/*` runs `authenticateBearer` from `src/api/middleware.ts` first, *except* `GET /api/picker/config` which is intentionally public (it returns the same Drive Picker key + project number that the inline `/picker` HTML already exposes). CORS is permissive (allow-listed extension + localhost origins) on the cross-origin routes. Today: `POST /api/extension/captures`, `POST /api/extension/doc-state`, `POST /api/extension/doc-sync`, `GET /api/picker/config`, `POST /api/picker/register-doc`.
- API tokens are opaque `dkt_<base64url>` strings stored as sha256 hashes in `api_token`. Issue with `bun docket token issue --user <email>`; the plaintext is shown once. Verification short-circuits before the DB lookup if the prefix doesn't match.
- The api layer is a thin shell — domain logic stays in `src/auth/`, `src/domain/`, etc. `oauth.ts` reuses `completeOAuth` from `src/auth/connect.ts`; the CLI's `bun docket connect` does too. `extension.ts` calls `ingestExtensionCaptures` from `src/domain/capture.ts`. `picker-register.ts` calls `createProject` from `src/domain/project.ts`.
- OAuth state is held in an in-memory `Map` for now (single Fly machine, `min_machines_running = 1`). Move to DB or signed cookie when the deploy scales out.
- Background loops: `startServer` launches `renewExpiringChannels` (~30 min) and `pollAllActiveVersions` (~10 min) timers in-process when `DOCKET_PUBLIC_BASE_URL` is set. `createVersion` also auto-subscribes a Drive `files.watch` channel best-effort using that base URL. Pass `{ backgroundLoops: false }` to `startServer` in tests to keep the timers off.
- Deployment is documented in [`README.md` §"Deployment"](./README.md#deployment-flyio).

## Browser extension (`surfaces/extension/`)

- Manifest V3, shared codebase across Chrome / Edge / Firefox. Phase 2 shipped the capture role; Phase 3 (current) layers the popup as a project surface — see "Popup states" below. The popup reads `tab.url` without the `tabs` permission because the manifest's `host_permissions: ["https://docs.google.com/*"]` covers Docs tabs.
- Build with `bun run surfaces/extension/build.ts` → `dist/{chromium,firefox}/`. Manifests are kept separate (`manifest.{chromium,firefox}.json`) so target-specific keys (`browser_specific_settings`, `background.scripts` vs `service_worker`) stay declarative.
- Content script (`src/content/`) bundles to a single non-module file (no top-level `import`/`export`); the SW + options + popup load as ES modules.
- DOM selectors live in two places: `surfaces/extension/src/content/sidebar-scraper.ts` (suggestion-thread replies) and `surfaces/extension/src/content/docs-content.ts`'s `DOC_NAME_SELECTORS` (the doc title input — used to populate the popup label and the Picker query in a locale-safe way). Both are a moving target (Docs reships ~quarterly); add new selectors at the head of the array, keep older ones for back-compat. Failures are silent by design. Replies are normalized up to their outermost `.docos-anchoredreplyview` wrapper before extraction so multiple selectors hitting nested descendants of the same reply don't double-count.
- Bootstrap diagnostics: the content script logs one `[docket] content script ready (doc=…)` line on load and one `[docket] first scan: threads=N suggestions=N captures=N fresh=N` summary on the first non-empty scan. Keep these — they're the only signal when the queue stays at 0 and you need to know whether the script ran, the selectors matched, or the suggestion-only filter dropped everything.
- Capture flow: content script → SW (dedupe vs `chrome.storage.local`) → POST `/api/extension/captures` with the user's API token. End-to-end idempotency is `(version_id, external_id)` on `canonical_comment`; the seen-id cache is just a perf hint.
- Doc-title cache: every scan also calls `setDocTitle(docId, name)` (`shared/storage.ts`) using the DOM-scraped doc name. The popup reads from this map instead of the localized `tab.title` (which carries a translatable " - Google Docs" suffix that breaks Picker's token-AND query matching). First popup-open after a fresh install may show "Google Doc" until the first scan completes (~750 ms after page load).
- **Backend origin permission.** The configured backend URL isn't known at build time, so the manifest declares `host_permissions: ["https://docs.google.com/*"]` for the content script and `optional_host_permissions: ["<all_urls>"]` for the SW's POSTs. The Options page's `Test connection` / `Save` handlers call `chrome.permissions.request({ origins: [...] })` for the typed origin (must run from a click — Chrome rejects programmatic `permissions.request` outside a user gesture). One build serves both `localhost` dev and Fly prod without manifest churn.
- Cross-browser: a tiny `surfaces/extension/src/shared/browser.ts` shim picks `globalThis.browser ?? chrome`. Don't add `webextension-polyfill` — its 30 KB dwarfs the rest of the bundle.
- Reloading the extension at `chrome://extensions` does not re-inject the content script into already-open doc tabs; hard-refresh the tab (Cmd-Shift-R) when iterating on the scraper.
- **Popup states** (`src/popup/popup.ts`, dispatched by `boot()`): `no-settings` (configure backend), `no-doc` (no Docs tab active), `untracked` ("Add to Docket" → opens the in-popup sandboxed Picker on Chromium / falls back to a backend `/picker` tab on Firefox), `tracked` (project info, version label, last-synced, comment count, "Sync now" button). All three project-surface paths talk to the SW via the `Message` envelope (`src/shared/messages.ts`) — `doc/state`, `doc/sync`, `doc/register`, `picker/config` — which forwards to the matching backend route with the user's API token.
- **Sandboxed Picker** (`src/popup/picker-sandbox.{html,ts,css}`). Loaded inside an iframe inside the popup; chromium manifest's `sandbox.pages` + `content_security_policy.sandbox` allow the external `https://accounts.google.com` and `https://apis.google.com` script loads that the regular extension_pages CSP forbids. The sandbox runs at `null` origin, so it can't reach the backend through CORS — instead it postMessages the picked doc id back up to the popup, and the popup (chrome-extension origin) hits `/api/picker/register-doc`. Firefox MV3 has no `sandbox.pages` support yet, so on Firefox the popup detects via UA string and opens the backend `/picker` page in a new tab instead.

## Schema migrations

- Edit `src/db/schema.ts`, then `bunx drizzle-kit generate` → `bun migrate`.
- Migrations apply at runtime via `drizzle-orm/bun-sqlite/migrator`. Don't add `better-sqlite3` as a runtime dep.
- `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.

## Config

- `src/config.ts` uses lazy getters; importing it doesn't require any env var. Only accessing a missing getter throws. Reflect new env vars in `.env.example`.

## Google integration

- Only `drive.file` for active doc operations. It's per-file (SPEC §9.2): the backend only sees docs Docket created, the user opened with the Workspace Add-on, or the user picked via Drive Picker. Every entry surface needs a "first time you reference a doc, here's how to authorize it" affordance.
- Never pass raw access tokens around. Build `tokenProviderForUser(userId)` and pass it to `authedFetch` / `authedJson<T>` — refresh-on-401 is automatic.
- New Drive/Docs endpoints go in `src/google/{drive,docs}.ts` as endpoint-shaped wrappers (not domain-shaped).
- Before re-litigating a Workspace API limitation, read SPEC §9. The constraints there (no anchored-comment authoring, canvas-rendered body, Card-only add-on UI, push-watch infra) are settled.

## Secrets

- Long-lived secrets (refresh tokens, etc.) round-trip through `encryptWithMaster` / `decryptWithMaster` — never store plaintext.

## Tests

- `bun test` runs the suite; `bun run typecheck` runs `tsc --noEmit`.
- Co-locate `*.test.ts` next to the module under test. Unit-test pure logic; exercise live Google APIs through CLI smoke commands rather than mocking `fetch`.
- Currently unit-tested: envelope encryption (round-trip, tampering, wrong-key, version byte), OAuth URL builder (scopes, state, prompt, redirect URI), Google Doc URL/ID parsing, anchor computation (paragraph-hash stability, snippet location, context capture, first-occurrence resolution, orphan handling), suggestion extraction (insertions, deletions, multi-run coalescence, cross-paragraph spans, replace-style runs), CORS allow-list + preflight, bearer-auth middleware shape, picker-register auth gating, doc-state lookup (parent/version role, cross-user isolation), doc-sync auth gating, `startServer` route table + background-loop opt-out (binds port 0).

---

# Bun

Default to Bun over Node. Project-relevant rules:

- Commands: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`. No `dotenv` — Bun loads `.env` automatically.
- APIs: `bun:sqlite` (no `better-sqlite3` runtime dep), `Bun.serve()` (no `express`), `Bun.file` (over `node:fs`), `Bun.$` (over `execa`).
- One exception: `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.
