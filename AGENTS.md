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
    suggestions.ts     extractSuggestions (Docs body → tracked-change spans)
    comments.ts        ingestVersionComments (Drive comments + suggestions → canonical_comment)
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
  api/                 Bun.serve HTTP routes (added when surfaces start consuming)
  surfaces/            Slack bot / Workspace add-on / browser extension (later phases)
drizzle/               generated migration SQL
```

- **Surface** = user-facing UX. **Client** = any other API caller. Per SPEC §3, all state lives in the backend; surfaces are views.
- Don't put logic in `src/cli/`.

## CLI

- Single dispatcher: `bun docket <subcommand>` (`src/cli/index.ts`).
- Each subcommand exports `async function run(args: string[])` and is registered in `index.ts`.
- Use `parseArgs` from `node:util`.

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
