# Margin — project conventions

Phased build plan in [`SPEC.md` §12](./SPEC.md#12-build-sequence) — each phase has a `Status:` line; keep those current as work lands.

If an action (e.g. `git push origin main`) is blocked by Claude Code's auto-mode classifier, don't tell the user it's impossible — ask them to say "I approve" and retry. Re-approval in chat lets the next attempt through.

## Repo layout

```
src/
  config.ts          lazy env-var getters; importing it doesn't require any env var
  db/                drizzle schema (16 tables, SPEC §4) + bun:sqlite client + migrator
  auth/              Better Auth server config (Google provider + bearer plugin),
                     envelope encryption, TokenProvider, test-only session helper
  google/            endpoint-shaped REST wrappers (drive/docs + the Google token-
                     refresh helper) — no domain logic; the OAuth URL builder lives
                     inside Better Auth's Google provider, not here
  domain/            business logic composing db/google/auth — no HTTP, no CLI. project,
                     version, anchor, reanchor, comments, project_comments, overlay,
                     watcher, doc-state, doc, inspect, project-detail, version-diff,
                     version-comments, comment-action, settings, review, review-action,
                     stats, user, smoke, dev-seed
  cli/               thin parse-and-call shells dispatched by index.ts (`bun margin <cmd>`)
  api/               Bun.serve HTTP host. server.ts owns the route table + in-process
                     renew/poll loops; one module per route (auth-handler for the
                     Better Auth catch-all + extension launch-tab/success bridge,
                     doc-state, doc-sync, drive-webhook, picker-page, picker-register,
                     project-detail, version-diff, version-comments, comment-action,
                     settings, review-action). middleware.ts + cors.ts hold the
                     bearer-auth + CORS helpers
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
- Don't put logic in `src/api/` — same rule. Routes call into `src/domain/` (e.g. `doc-sync.ts` → `ingestVersionComments`, `picker-register.ts` → `createProject`). Auth lives in Better Auth (`src/auth/server.ts`), not in route modules.

## CLI

- Single dispatcher: `bun margin <subcommand>` (`src/cli/index.ts`).
- Each subcommand exports `async function run(args: string[])` and is registered in `index.ts`.
- Subcommands with multiple verbs (`comments {ingest,list}`, `watcher {subscribe,...}`) use `dispatchSubcommands(args, USAGE, table)` from `cli/util.ts` rather than hand-rolling the `if (sub === ...) {}` chain.
- Use `parseArgs` from `node:util`.
- Exit codes: `usage(text)` exits 2 (Unix convention for misuse); `fatal(text)` exits 1 (runtime failure).

## Domain conventions

- **Not-found pairs.** Each domain entity has a nullable getter (`getProject`, `getVersion`, `getOverlay`, `getUserByEmail`, `firstUser`) and a throwing partner (`requireProject`, `requireVersion`, `requireOverlay`, `requireUserByEmail`, `requireFirstUser`). Most call sites want the throwing variant — reach for the nullable one only when "missing" is a normal branch (e.g. "is this doc already a project?"). Don't inline `(await db.select()…)[0]; if (!x) throw …` — use the helper.
- **Token-provider sugar.** Sites whose only reason to fetch a project is to get the owner's `userId` should call `tokenProviderForProject(projectId)`. Sites that need other project fields call `requireProject` and pass `proj.ownerUserId` to `tokenProviderForUser` themselves.

## HTTP API

- `bun margin serve [--port <n>]` runs the API host (`Bun.serve`, in `src/api/server.ts`). The Fly container runs the same command; deployment lives in [`README.md` §"Deployment"](./README.md#deployment-flyio).
- **Route table.** Register new routes in `server.ts`'s table — never branch `pathname` inline. Each route is its own module under `src/api/` and is a thin shell that delegates into `src/domain/` (e.g. `doc-sync.ts` → `ingestVersionComments`, `picker-register.ts` → `createProject`).
- **Auth.** Better Auth (`src/auth/server.ts`) owns the `/api/auth/**` route tree (sign-in, Google OAuth callback, get-session, sign-out) plus the `user`, `session`, `account`, and `verification` tables. `authenticateBearer` in `src/api/middleware.ts` is a thin wrapper over `auth.api.getSession({ headers })` and returns `{ userId, sessionId }`; the bearer plugin accepts the raw `session.token` as `Authorization: Bearer …`. Google refresh tokens are envelope-encrypted in `account.refreshToken` via a `databaseHooks.account` write hook; `TokenProvider` in `src/auth/credentials.ts` decrypts them and refreshes Drive access tokens against Google directly. The picker page `GET /api/picker/page` authenticates via the same session cookie (top-level navigation, not a CORS XHR).
- **Extension sign-in.** `GET /api/auth/ext/launch-tab?ext=<chrome.runtime.id>` kicks off Google OAuth via Better Auth's `signInSocial`; the inner `callbackURL` points at `/api/auth/ext/success`, which renders an HTML bridge page that hands the session token to the SW (Chromium: `chrome.runtime.sendMessage` gated by `externally_connectable.matches`; Firefox: `location.hash` picked up by the SW's `tabs.onUpdated`). The SW persists the token in `chrome.storage.local`. The `ext` parameter is allow-listed against Chromium/Firefox id formats to prevent open-redirect abuse.
- **CORS.** Permissive allow-list (extension + localhost origins) on cross-origin routes — see `src/api/cors.ts`.
- **Background loops.** `startServer` launches `renewExpiringChannels` (~30 min) and `pollAllActiveVersions` (~10 min) timers in-process when `MARGIN_PUBLIC_BASE_URL` is set. `createVersion` also auto-subscribes a Drive `files.watch` channel best-effort using that base URL. Pass `{ backgroundLoops: false }` to `startServer` in tests.
- **Webhooks.** `POST /webhooks/drive` always responds 200 OK so Google stops retrying — channel-level errors get logged.

## Frontend stack

- Astro for the public site (`docs/`), WXT for the extension. Preact is the shared component layer. Extension-only UI lives in `surfaces/extension/ui/`; if a second surface lands and we end up duplicating components, hoist them into a `surfaces/shared-ui/` package then (not before).

## Browser extension (`surfaces/extension/`)

Build pipeline, file layout, popup state machine, Picker mechanics, and DOM-selector contract live in [`surfaces/extension/README.md`](./surfaces/extension/README.md). Design intent + phase scope: [`SPEC.md` §6.4](./SPEC.md#64-browser-extension). Conventions to know when working on this surface:

- **Don't build by hand.** Always go through the WXT scripts (`bun run ext:build` / `ext:build:firefox` / `ext:dev`). Run `bunx wxt prepare` after edits that affect TypeScript so `.wxt/wxt.d.ts` regenerates.
- **Cross-browser API.** Import `{ browser }` from `wxt/browser` — WXT ships its own promisified shim. Don't add `webextension-polyfill` (30 KB) or hand-roll a `chrome ?? browser` picker.
- **No content script.** Ingest is server-side (`.docx` export, SPEC §9.8); the extension is a pure UI surface — popup, options, side panel. The Drive Picker is hosted on the backend at `/api/picker/page` and opens as a new tab from the popup's *Add to Margin* button. The manifest declares only `optional_host_permissions: ["<all_urls>"]` for the user-configured backend origin; there is no static `host_permissions` block. The Options page's `Test connection` / `Save` handlers call `chrome.permissions.request({ origins: [...] })` from a click handler (Chrome rejects programmatic `permissions.request` outside a user gesture).
- **Doc title from `tab.title`.** The popup reads `chrome.tabs.query()`'s `tab.title` and passes it through `cleanDocTitle()` in `utils/ids.ts`, which strips the trailing locale `" - Google Docs"` suffix. No on-doc DOM scrape and no per-doc title cache.
- **Preact only in the popup + side panel.** Options + SW stay plain TS — no UI state worth a component framework.
- **Backend calls go through the SW.** All popup → backend traffic uses the `Message` envelope in `utils/messages.ts` (`doc/state`, `doc/sync`, `doc/register`, `project/detail`, `version/{diff,comments}`). The popup never touches the API token directly. The backend-hosted picker page calls `/api/picker/register-doc` itself with the session cookie — no SW round-trip.
- **Toolbar-icon routing.** Tracked Doc tabs open the side-panel dashboard directly on icon click; everything else falls back to the popup state machine. The SW (`entrypoints/background.ts`) toggles `action.setPopup({ tabId, popup: "" })` per tab inside `evaluateAction()` based on cached `doc/state` results, and `action.onClicked` opens the side panel. **Adding a filled-icon variant later:** drop the new PNGs under `surfaces/extension/public/icons/` (e.g. `icon-tracked-16.png`, …), then in `evaluateAction()` call `browser.action.setIcon({ tabId, path: { 16: "icons/icon-tracked-16.png", 32: …, 48: …, 128: … } })` for tracked tabs and the default `icons/icon-16.png` set for everything else — keep the icon swap colocated with the `safeSetPopup` call so the two states never drift apart. No manifest change needed (the default-icon block in `wxt.config.ts` stays as-is — `setIcon` is per-tab and overrides at runtime).
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
- The Google OAuth URL builder + code-exchange path lives inside Better Auth's Google provider (`src/auth/server.ts`). `src/google/oauth.ts` is now just the token-refresh helper that `TokenProvider` calls to swap the encrypted `account.refresh_token` for a fresh access token.
- Before re-litigating a Workspace API limitation, read SPEC §9. The constraints there (no anchored-comment authoring, canvas-rendered body, Card-only add-on UI, push-watch infra) are settled.

## Secrets

- Long-lived secrets (refresh tokens, etc.) round-trip through `encryptWithMaster` / `decryptWithMaster` — never store plaintext. The Google `account.refresh_token` is handled by the `databaseHooks.account.{create,update}.before` hook in `src/auth/server.ts`; new fields that need at-rest encryption should attach a similar hook rather than encrypting inside domain code.

## Tests

- `bun test` runs the suite; `bun run typecheck` runs `tsc --noEmit`.
- Co-locate `*.test.ts` next to the module under test. Unit-test pure logic; exercise live Google APIs through CLI smoke commands rather than mocking `fetch`.
- Currently unit-tested: envelope encryption (round-trip, tampering, wrong-key, version byte), Google Doc URL/ID parsing, anchor computation (paragraph-hash stability, snippet location, context capture, first-occurrence resolution, orphan handling), OOXML docx parse (plain comments, multi-paragraph + disjoint multi-range, suggestion insert/delete with author + timestamp, reply-on-suggestion overlap, footer/footnote regions, malformed zip handling), CORS allow-list + preflight, picker-register auth gating, doc-state lookup (parent/version role, cross-user isolation), doc-sync auth gating, `startServer` route table + background-loop opt-out (binds port 0), comment-action auth/owner-scope + state transitions, settings load + patch round-trip + email validation, magic-link review-action redeem (single-use, expiry, decline transition). Better Auth's sign-in / session / OAuth flows are covered by the upstream package's own tests — Margin tests don't re-litigate them and instead use `issueTestSession` (in `src/auth/test-session.ts`) to bypass the OAuth dance for route tests.

---

# Bun

Default to Bun over Node. Project-relevant rules:

- Commands: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`. No `dotenv` — Bun loads `.env` automatically.
- APIs: `bun:sqlite` (no `better-sqlite3` runtime dep), `Bun.serve()` (no `express`), `Bun.file` (over `node:fs`), `Bun.$` (over `execa`).
- One exception: `drizzle.config.ts` runs under Node (drizzle-kit), so it uses `process.env`, not `Bun.env`.
