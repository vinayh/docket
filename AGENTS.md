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
    server.ts          route table; dispatches to per-route modules
    oauth.ts           OAuth start + callback handlers (in-memory state store)
    middleware.ts      bearer auth + JSON response helpers
    cors.ts            permissive CORS for /api/extension/* (extension origin)
    extension.ts       POST /api/extension/captures (browser-extension ingest)
    drive-webhook.ts   POST /webhooks/drive (drive.files.watch push receiver)
    picker.ts          GET /picker (Drive Picker host page — stub today)
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
- Public routes today: `/healthz`, `/oauth/start`, `/oauth/callback`, `/picker` (Drive Picker host stub).
- Webhooks: `POST /webhooks/drive` (Drive `files.watch` push receiver). Always responds 200 OK so Google stops retrying — channel-level errors get logged.
- Bearer-authenticated API surface: anything under `/api/*` runs `authenticateBearer` from `src/api/middleware.ts` first. CORS is permissive on `/api/extension/*` (the extension's service worker fetches across origins). Today: `POST /api/extension/captures`.
- API tokens are opaque `dkt_<base64url>` strings stored as sha256 hashes in `api_token`. Issue with `bun docket token issue --user <email>`; the plaintext is shown once. Verification short-circuits before the DB lookup if the prefix doesn't match.
- The api layer is a thin shell — domain logic stays in `src/auth/`, `src/domain/`, etc. `oauth.ts` reuses `completeOAuth` from `src/auth/connect.ts`; the CLI's `bun docket connect` does too. `extension.ts` calls `ingestExtensionCaptures` from `src/domain/capture.ts`.
- OAuth state is held in an in-memory `Map` for now (single Fly machine, `min_machines_running = 1`). Move to DB or signed cookie when the deploy scales out.
- Deployment is documented in [`README.md` §"Deployment"](./README.md#deployment-flyio).

## Browser extension (`surfaces/extension/`)

- Manifest V3, shared codebase across Chrome / Edge / Firefox. Phase-2 scope is the capture role only (SPEC §6.4).
- Build with `bun run surfaces/extension/build.ts` → `dist/{chromium,firefox}/`. Manifests are kept separate (`manifest.{chromium,firefox}.json`) so target-specific keys (`browser_specific_settings`, `background.scripts` vs `service_worker`) stay declarative.
- Content script (`src/content/`) bundles to a single non-module file (no top-level `import`/`export`); the SW + options + popup load as ES modules.
- DOM selectors live in `surfaces/extension/src/content/sidebar-scraper.ts`. They are a moving target (Docs reships ~quarterly); add new selectors at the head of each `*_SELECTORS` array, keep older ones for back-compat. Failures are silent by design. Replies are normalized up to their outermost `.docos-anchoredreplyview` wrapper before extraction so multiple selectors hitting nested descendants of the same reply don't double-count.
- Bootstrap diagnostics: the content script logs one `[docket] content script ready (doc=…)` line on load and one `[docket] first scan: threads=N suggestions=N captures=N fresh=N` summary on the first non-empty scan. Keep these — they're the only signal when the queue stays at 0 and you need to know whether the script ran, the selectors matched, or the suggestion-only filter dropped everything.
- Capture flow: content script → SW (dedupe vs `chrome.storage.local`) → POST `/api/extension/captures` with the user's API token. End-to-end idempotency is `(version_id, external_id)` on `canonical_comment`; the seen-id cache is just a perf hint.
- **Backend origin permission.** The configured backend URL isn't known at build time, so the manifest declares `host_permissions: ["https://docs.google.com/*"]` for the content script and `optional_host_permissions: ["<all_urls>"]` for the SW's POSTs. The Options page's `Test connection` / `Save` handlers call `chrome.permissions.request({ origins: [...] })` for the typed origin (must run from a click — Chrome rejects programmatic `permissions.request` outside a user gesture). One build serves both `localhost` dev and Fly prod without manifest churn.
- Cross-browser: a tiny `surfaces/extension/src/shared/browser.ts` shim picks `globalThis.browser ?? chrome`. Don't add `webextension-polyfill` — its 30 KB dwarfs the rest of the bundle.
- Reloading the extension at `chrome://extensions` does not re-inject the content script into already-open doc tabs; hard-refresh the tab (Cmd-Shift-R) when iterating on the scraper.

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
- Currently unit-tested: envelope encryption (round-trip, tampering, wrong-key, version byte), OAuth URL builder (scopes, state, prompt, redirect URI), Google Doc URL/ID parsing, anchor computation (paragraph-hash stability, snippet location, context capture, first-occurrence resolution, orphan handling), suggestion extraction (insertions, deletions, multi-run coalescence, cross-paragraph spans, replace-style runs).

---

# Bun

Default to Bun over Node. Project-relevant rules:

- Commands: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`. No `dotenv` — Bun loads `.env` automatically.
- APIs: `bun:sqlite` (no `better-sqlite3` runtime dep), `Bun.serve()` (no `express`), `Bun.file` (over `node:fs`), `Bun.$` (over `execa`).
- One exception: `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.
