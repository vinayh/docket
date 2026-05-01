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
  domain/
    google-doc-url.ts  parse doc IDs out of URLs
    project.ts         createProject / getProject / list*
    version.ts         createVersion (copies parent doc, hashes snapshot) / list / archive
  cli/
    index.ts           subcommand dispatcher (`bun docket <cmd>`)
    util.ts            shared helpers (default user, etc.)
    connect.ts         one-shot OAuth callback receiver
    smoke.ts           end-to-end: getFile + copyFile + listComments
    project.ts         project create / list
    version.ts         version create / list
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
   bun migrate
   ```

## CLI

Run any subcommand with `bun docket <subcommand>`:

```
bun docket connect                                        connect a Google account
bun docket smoke <doc-url>                                getFile + copyFile + listComments
bun docket project create <doc-url> [--user <email>]      register a doc as a project
bun docket project list
bun docket version create <project-id> [--label v1]       snapshot the parent into a new version
bun docket version list <project-id>
```

The `--user <email>` flag selects which connected account acts as the doc owner; if omitted, the first user in the DB is used.

## Validation (end-to-end smoke test)

After setup, you can connect a real Google account and exercise the full stack:

```sh
# 1. Connect a Google account.
#    Opens a consent URL; the local callback server captures the code,
#    upserts a user row, and stores an encrypted refresh token.
bun docket connect

# 2. Sanity-check the Drive/Docs wrappers against a doc you own.
bun docket smoke 'https://docs.google.com/document/d/<doc-id>/edit'

# 3. Register the doc as a project, then snapshot it into v1.
bun docket project create 'https://docs.google.com/document/d/<doc-id>/edit'
bun docket project list                # copy the project id from here
bun docket version create <project-id>
bun docket version list <project-id>
```

Each `version create` copies the parent doc via Drive, names the copy `[docket vN] <original>`, and stores a SHA-256 hash of the copy's plaintext as the snapshot fingerprint.

## Tests

```sh
bun test
```

Unit-tested so far:

- Envelope encryption: round-trip, randomized ciphertexts, tampering detection, wrong-key rejection, version byte checks.
- OAuth URL builder: scopes, state, prompt overrides, custom redirect URIs.
- Google Doc URL/ID parsing.

Wrappers around live Google APIs and the project/version flow are validated via the CLI against a real doc rather than mocked unit tests.

## Schema migrations

Schema lives in `src/db/schema.ts`. After editing:

```sh
bunx drizzle-kit generate    # emits a new SQL file in ./drizzle
bun migrate                  # applies it
```

`drizzle-kit` runs under Node (not Bun), so `drizzle.config.ts` uses `process.env`. Migrations are applied at runtime via `drizzle-orm/bun-sqlite/migrator` — `better-sqlite3` is not a runtime dependency.

## Build phases

Tracking SPEC §11.

- [ ] **Phase 1** — core engine: project/version model, doc-copy + overlay application, canonical comment store, reanchoring engine, doc-watcher. CLI for testing.
  - [x] Drizzle schema for all 12 tables (§4)
  - [x] Envelope-encrypted refresh-token storage
  - [x] Google OAuth flow + `TokenProvider` with auto-refresh
  - [x] Drive + Docs API wrappers
  - [x] Project + Version primitives (creating projects from a parent doc, snapshotting versions)
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
