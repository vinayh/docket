# docket

Structured review and version tracking of Google Docs through a sidebar add-on and Slack bot.

See [`SPEC.md`](./SPEC.md) for the full design. Status: **Phase 1 in progress** — core engine.

## Stack

- Runtime: Bun
- DB: `bun:sqlite` + Drizzle ORM (Postgres later, when we need multi-process)
- HTTP: `Bun.serve()` (no Express)
- Encryption: WebCrypto AES-GCM, envelope-style for refresh tokens
- Tests: `bun test`

## Repository layout

```
src/
  config.ts            lazy env-var config
  db/
    schema.ts          12 tables from SPEC §4
    client.ts          drizzle + bun:sqlite (WAL, FK on)
    migrate.ts         applies generated migrations
  auth/
    encryption.ts      envelope encryption (KEK → per-row DEK → ciphertext)
    credentials.ts     TokenProvider with in-memory cache + auto-refresh
    connect.ts         completes OAuth: upserts user, stores encrypted refresh token
  google/
    oauth.ts           authorize URL, code exchange, refresh, userinfo
    api.ts             authedFetch / authedJson — refresh-on-401
    drive.ts           files.get / files.copy / comments.list / files.watch / permissions
    docs.ts            documents.get / documents.batchUpdate + op.* helpers
  cli/
    connect.ts         one-shot OAuth callback receiver
    smoke.ts           end-to-end: getFile + copyFile + listComments
drizzle/               generated migration SQL
```

## Setup

1. **Clone + install**

   ```sh
   bun install
   ```

2. **Create a Google Cloud OAuth client.**
   In [console.cloud.google.com](https://console.cloud.google.com), create a project, enable the **Google Drive API** and **Google Docs API**, then create an OAuth 2.0 client (type: web application). Add `http://localhost:8787/oauth/callback` as an authorized redirect URI.

3. **Generate a master key for envelope encryption** (32 bytes, base64-encoded):

   ```sh
   bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))'
   ```

4. **Create `.env`** by copying `.env.example` and filling in:

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:8787/oauth/callback
   DOCKET_MASTER_KEY=<base64 from step 3>
   DOCKET_DB_PATH=./docket.db
   ```

   Bun loads `.env` automatically.

5. **Apply migrations:**

   ```sh
   bun src/db/migrate.ts
   ```

## Validation (end-to-end smoke test)

After setup, you can connect a real Google account and hit the Drive API through the full stack:

```sh
# 1. Connect a Google account.
#    Opens a consent URL; the local callback server captures the code,
#    upserts a user row, and stores an encrypted refresh token.
bun src/cli/connect.ts

# 2. Run the smoke test against a doc you own.
#    Calls getFile → copyFile → listComments using the stored credentials,
#    auto-refreshing the access token as needed.
bun src/cli/smoke.ts 'https://docs.google.com/document/d/<doc-id>/edit'
```

Expected output: file metadata, a copied doc with the prefix `[docket smoke]`, and the comment count for the original.

## Tests

```sh
bun test
```

Unit-tested so far:

- Envelope encryption: round-trip, randomized ciphertexts, tampering detection, wrong-key rejection, version byte checks.
- OAuth URL builder: scopes, state, prompt overrides, custom redirect URIs.

Wrappers around live Google APIs are validated via the smoke CLI rather than mocked unit tests.

## Schema migrations

Schema lives in `src/db/schema.ts`. After editing:

```sh
bunx drizzle-kit generate    # emits a new SQL file in ./drizzle
bun src/db/migrate.ts        # applies it
```

`drizzle-kit` runs under Node (not Bun), so `drizzle.config.ts` uses `process.env`. Migrations are applied at runtime via `drizzle-orm/bun-sqlite/migrator` — `better-sqlite3` is not a runtime dependency.

## Build phases

Tracking SPEC §11.

- [ ] **Phase 1** — core engine: project/version model, doc-copy + overlay application, canonical comment store, reanchoring engine, doc-watcher. CLI for testing.
  - [x] Drizzle schema for all 12 tables (§4)
  - [x] Envelope-encrypted refresh-token storage
  - [x] Google OAuth flow + `TokenProvider` with auto-refresh
  - [x] Drive + Docs API wrappers
  - [ ] Project + Version primitives (creating projects from a parent doc, snapshotting versions)
  - [ ] Canonical comment ingestion
  - [ ] Reanchoring engine
  - [ ] Overlay model + applier
  - [ ] Drive push-notification doc-watcher
  - [ ] Phase-1 CLI
- [ ] **Phase 2** — Slack bot
- [ ] **Phase 3** — Web app (reconciliation UI, diff views, overlay editor)
- [ ] **Phase 4** — Workspace add-on
- [ ] **Phase 5** — Cross-org polish
- [ ] **Phase 6** — Marketplace, advanced features

## Conventions

- Use Bun APIs over Node equivalents (per [`CLAUDE.md`](./CLAUDE.md)). `bun:sqlite`, `Bun.serve`, `Bun.file`, `Bun.$`.
- All state lives in the backend; surfaces (Slack/add-on/web) are views (SPEC §3).
- The only Google scope held for active doc operations is `drive.file` (SPEC §8).
