# Margin — project conventions

Phased build plan in [`SPEC.md` §12](./SPEC.md#12-build-sequence) — each phase has a `Status:` line; keep those current as work lands.

## Repo layout

```
src/
  config.ts          lazy env-var getters; importing it doesn't require any env var
  db/                drizzle schema (12 tables, SPEC §4) + bun:sqlite client + migrator
  auth/              envelope encryption, OAuth credentials/TokenProvider, opaque API tokens
  google/            endpoint-shaped REST wrappers (oauth/api/drive/docs) — no domain logic
  domain/            business logic composing db/google/auth — no HTTP, no CLI. project,
                     version, anchor, reanchor, comments, project_comments, overlay,
                     watcher, doc-state, project-detail, version-diff, version-comments,
                     stats, user, review, smoke
  cli/               thin parse-and-call shells dispatched by index.ts (`bun margin <cmd>`)
  api/               Bun.serve HTTP host. server.ts owns the route table + in-process
                     renew/poll loops; one module per route (oauth, doc-state, doc-sync,
                     drive-webhook, picker, picker-config, picker-register,
                     project-detail, version-diff, version-comments). middleware.ts +
                     cors.ts hold the bearer-auth + CORS helpers
surfaces/extension/  MV3 extension (Chrome / Edge / Firefox), WXT-driven — see
                     surfaces/extension/README.md
docs/                Astro + Preact public site; deploys to GitHub Pages
drizzle/             generated migration SQL
Dockerfile           multi-stage Bun-on-Alpine image; runs migrate then serve
fly.toml             Fly.io app config (see README §"Deployment")
.github/workflows/   ci.yml: typecheck + bun test + codecov + fly-deploy on main.
                     integration.yml: nightly live-Google suite. pages.yml: docs/ → Pages
```

- **Surface** = user-facing UX. **Client** = any other API caller. Per SPEC §3, all state lives in the backend; surfaces are views.
- Don't put logic in `src/cli/` — it's a parse-and-call shell over `src/domain/`.
- Don't put logic in `src/api/` — same rule. Routes call into `src/domain/` (e.g. `doc-sync.ts` → `ingestVersionComments`, `picker-register.ts` → `createProject`, `oauth.ts` → `completeOAuth`).

## CLI

- Single dispatcher: `bun margin <subcommand>` (`src/cli/index.ts`).
- Each subcommand exports `async function run(args: string[])` and is registered in `index.ts`.
- Subcommands with multiple verbs (`comments {ingest,list}`, `watcher {subscribe,...}`) use `dispatchSubcommands(args, USAGE, table)` from `cli/util.ts` rather than hand-rolling the `if (sub === ...) {}` chain.
- Use `parseArgs` from `node:util`.
- Exit codes: `usage(text)` exits 2 (Unix convention for misuse); `fatal(text)` exits 1 (runtime failure). `die` is a deprecated alias for `fatal`.

## Domain conventions

- **Not-found pairs.** Each domain entity has a nullable getter (`getProject`, `getVersion`, `getOverlay`, `getUserByEmail`, `firstUser`) and a throwing partner (`requireProject`, `requireVersion`, `requireOverlay`, `requireUserByEmail`, `requireFirstUser`). Most call sites want the throwing variant — reach for the nullable one only when "missing" is a normal branch (e.g. "is this doc already a project?"). Don't inline `(await db.select()…)[0]; if (!x) throw …` — use the helper.
- **Token-provider sugar.** Sites whose only reason to fetch a project is to get the owner's `userId` should call `tokenProviderForProject(projectId)`. Sites that need other project fields call `requireProject` and pass `proj.ownerUserId` to `tokenProviderForUser` themselves.

## HTTP API

- `bun margin serve [--port <n>]` runs the API host (`Bun.serve`, in `src/api/server.ts`). The Fly container runs the same command; deployment lives in [`README.md` §"Deployment"](./README.md#deployment-flyio).
- **Route table.** Register new routes in `server.ts`'s table — never branch `pathname` inline. Each route is its own module under `src/api/` and is a thin shell that delegates into `src/domain/` (e.g. `doc-sync.ts` → `ingestVersionComments`, `picker-register.ts` → `createProject`, `oauth.ts` → `completeOAuth`).
- **Auth.** `authenticateBearer` from `src/api/middleware.ts` gates everything under `/api/*` *except* `GET /api/picker/config`, which is intentionally public (returns the same Picker key + project number the inline `/picker` HTML already exposes). API tokens are opaque `mgn_<base64url>` strings stored as sha256 hashes; verification short-circuits before the DB lookup if the prefix doesn't match.
- **CORS.** Permissive allow-list (extension + localhost origins) on cross-origin routes — see `src/api/cors.ts`.
- **OAuth state.** In-memory `Map` for now (single Fly machine, `min_machines_running = 1`). Move to DB or signed cookie when the deploy scales out.
- **Background loops.** `startServer` launches `renewExpiringChannels` (~30 min) and `pollAllActiveVersions` (~10 min) timers in-process when `MARGIN_PUBLIC_BASE_URL` is set. `createVersion` also auto-subscribes a Drive `files.watch` channel best-effort using that base URL. Pass `{ backgroundLoops: false }` to `startServer` in tests.
- **Webhooks.** `POST /webhooks/drive` always responds 200 OK so Google stops retrying — channel-level errors get logged.

## Frontend stack

- Astro for the public site (`docs/`), WXT for the extension. Preact is the shared component layer; pull repeated UI into `surfaces/shared-ui/` on the second consumer.

## Browser extension (`surfaces/extension/`)

Build pipeline, file layout, popup state machine, Picker mechanics, and DOM-selector contract live in [`surfaces/extension/README.md`](./surfaces/extension/README.md). Design intent + phase scope: [`SPEC.md` §6.4](./SPEC.md#64-browser-extension). Conventions to know when working on this surface:

- **Don't build by hand.** Always go through the WXT scripts (`bun run ext:build` / `ext:build:firefox` / `ext:dev`). Run `bunx wxt prepare` after edits that affect TypeScript so `.wxt/wxt.d.ts` regenerates.
- **Cross-browser API.** Import `{ browser }` from `wxt/browser` — WXT ships its own promisified shim. Don't add `webextension-polyfill` (30 KB) or hand-roll a `chrome ?? browser` picker.
- **No content script.** Ingest is server-side (`.docx` export, SPEC §9.8); the extension is a pure UI surface — popup, options, side panel, picker sandbox. The manifest declares only `optional_host_permissions: ["<all_urls>"]` for the user-configured backend origin; there is no static `host_permissions` block. The Options page's `Test connection` / `Save` handlers call `chrome.permissions.request({ origins: [...] })` from a click handler (Chrome rejects programmatic `permissions.request` outside a user gesture).
- **Doc title from `tab.title`.** The popup reads `chrome.tabs.query()`'s `tab.title` and passes it through `cleanDocTitle()` in `utils/ids.ts`, which strips the trailing locale `" - Google Docs"` suffix so the Picker's token-AND filter works. No on-doc DOM scrape and no per-doc title cache.
- **Preact only in the popup + side panel.** Options, SW, and picker sandbox stay plain TS — no UI state worth a component framework.
- **Backend calls go through the SW.** All popup → backend traffic uses the `Message` envelope in `utils/messages.ts` (`doc/state`, `doc/sync`, `doc/register`, `picker/config`, `project/detail`, `version/{diff,comments}`). The popup never touches the API token directly; the picker sandbox can't (it's at `null` origin and not in CORS allow-list).
- **E2E rig via `chrome-devtools-mcp`** (`.mcp.json` at repo root). Persistent Chrome profile at `.margin-test-chrome/` (gitignored), pre-warmed with the test Google account (`MARGIN_TEST_USER_EMAIL` in `.env`, OAuth-connected to local backend). Don't pass `--load-extension` — it's silently ignored under Puppeteer-launched Chrome; use `--categoryExtensions` + the `install_extension` MCP tool against `surfaces/extension/dist/chrome-mv3` instead. After install, pre-populate settings via `chrome.storage.local.set` in the SW context (`evaluate_script` with `serviceWorkerId`), then drive a real click on the Options page's *Test connection* button to grant `http://localhost:8787/*` (Chrome rejects programmatic `permissions.request` without a user gesture). Leave `--use-mock-keychain` on — stripping it wipes the test account's cookies. Keep the profile dir to a throwaway account.

## Schema migrations

- Edit `src/db/schema.ts`, then `bunx drizzle-kit generate` → `bun migrate`.
- Migrations apply at runtime via `drizzle-orm/bun-sqlite/migrator`. Don't add `better-sqlite3` as a runtime dep.
- `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.

## Config

- `src/config.ts` uses lazy getters; importing it doesn't require any env var. Only accessing a missing getter throws. Reflect new env vars in `.env.example`.

## Google integration

- Only `drive.file` for active doc operations. It's per-file (SPEC §9.2): the backend only sees docs Margin created, the user opened with the Workspace Add-on, or the user picked via Drive Picker. Every entry surface needs a "first time you reference a doc, here's how to authorize it" affordance.
- Never pass raw access tokens around. Build `tokenProviderForUser(userId)` and pass it to `authedFetch` / `authedJson<T>` — refresh-on-401 is automatic.
- New Drive/Docs endpoints go in `src/google/{drive,docs}.ts` as endpoint-shaped wrappers (not domain-shaped).
- Before re-litigating a Workspace API limitation, read SPEC §9. The constraints there (no anchored-comment authoring, canvas-rendered body, Card-only add-on UI, push-watch infra) are settled.

## Secrets

- Long-lived secrets (refresh tokens, etc.) round-trip through `encryptWithMaster` / `decryptWithMaster` — never store plaintext.

## Tests

- `bun test` runs the suite; `bun run typecheck` runs `tsc --noEmit`.
- Co-locate `*.test.ts` next to the module under test. Unit-test pure logic; exercise live Google APIs through CLI smoke commands rather than mocking `fetch`.
- Currently unit-tested: envelope encryption (round-trip, tampering, wrong-key, version byte), OAuth URL builder (scopes, state, prompt, redirect URI), Google Doc URL/ID parsing, anchor computation (paragraph-hash stability, snippet location, context capture, first-occurrence resolution, orphan handling), OOXML docx parse (plain comments, multi-paragraph + disjoint multi-range, suggestion insert/delete with author + timestamp, reply-on-suggestion overlap, footer/footnote regions, malformed zip handling), CORS allow-list + preflight, bearer-auth middleware shape, picker-register auth gating, doc-state lookup (parent/version role, cross-user isolation), doc-sync auth gating, `startServer` route table + background-loop opt-out (binds port 0).

---

# Bun

Default to Bun over Node. Project-relevant rules:

- Commands: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`. No `dotenv` — Bun loads `.env` automatically.
- APIs: `bun:sqlite` (no `better-sqlite3` runtime dep), `Bun.serve()` (no `express`), `Bun.file` (over `node:fs`), `Bun.$` (over `execa`).
- One exception: `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.
