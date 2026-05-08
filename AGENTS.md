# Docket — project conventions

Phase-1 backend per [`SPEC.md`](./SPEC.md). Track progress in [`README.md` §"Build phases"](./README.md#build-phases) — keep the checklist current as work lands.

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
  api/                 Bun.serve HTTP host
    server.ts          route table; /healthz + /oauth/{start,callback}
    oauth.ts           OAuth start + callback handlers (in-memory state store)
  surfaces/            Slack bot / Workspace add-on / browser extension (later phases)
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
- Use `parseArgs` from `node:util`.

## HTTP API

- `bun docket serve [--port <n>]` runs the API host (`Bun.serve`, in `src/api/server.ts`). In production, the Fly container runs the same command; `PORT` and `DOCKET_DB_PATH` are set via `fly.toml`, secrets via `flyctl secrets set`.
- Routes live in `src/api/`. The server file does `(method, pathname)` dispatch and forwards to per-route modules.
- Public routes today: `/healthz`, `/oauth/start`, `/oauth/callback`. Anything user-authenticated lands under `/api/*` once API tokens + bearer middleware are wired (Phase-2 next step).
- The api layer is a thin shell — domain logic stays in `src/auth/`, `src/domain/`, etc. `oauth.ts` reuses `completeOAuth` from `src/auth/connect.ts`; the CLI's `bun docket connect` does too.
- OAuth state is held in an in-memory `Map` for now (single Fly machine, `min_machines_running = 1`). Move to DB or signed cookie when the deploy scales out.
- Deployment is documented in [`README.md` §"Deployment"](./README.md#deployment-flyio).

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
