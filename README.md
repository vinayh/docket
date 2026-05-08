# Docket

Structured review and version tracking of Google Docs through a sidebar add-on and Slack bot.

See [`SPEC.md`](./SPEC.md) for the full design. Status: **Phase 1 in progress** — core engine.

## Stack

- Runtime: Bun
- DB: `bun:sqlite` + Drizzle ORM (Postgres later, when we need multi-process)
- HTTP: `Bun.serve()` (no Express)
- Encryption: WebCrypto AES-GCM, envelope-style for refresh tokens
- Tests: `bun test`

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
bun docket doc create [--title <t>] [--seed]              create a fresh Docs API doc (auto drive.file access)
bun docket smoke <doc-url>                                getFile + copyFile + listComments
bun docket inspect <doc-url>                              dump raw Drive/Docs API responses (debugging)
bun docket project create <doc-url> [--user <email>]      register a doc as a project
bun docket project list
bun docket version create <project-id> [--label v1]       snapshot the parent into a new version
bun docket version list <project-id>
bun docket comments ingest <version-id>                   pull Drive comments into the canonical store
bun docket comments list <project-id>
```

The `--user <email>` flag selects which connected account acts as the doc owner; if omitted, the first user in the DB is used.

## Validation (end-to-end smoke test)

After setup, you can connect a real Google account and exercise the full stack:

```sh
# 1. Connect a Google account.
#    Opens a consent URL; the local callback server captures the code,
#    upserts a user row, and stores an encrypted refresh token.
bun docket connect

# 2. Create a fresh doc to test against.
#    The OAuth client gets drive.file access automatically because it created the file.
#    A URL of a pre-existing doc you own won't work yet — drive.file is per-file (SPEC §9.2);
#    the Drive Picker (Phase 2) and Workspace Add-on (Phase 5) are the other entry points.
bun docket doc create --seed
# → ✓ created doc <doc-id>
#   url: https://docs.google.com/document/d/<doc-id>/edit
# Open the URL, add a few comments by highlighting text and clicking "Comment".

# 3. Sanity-check the Drive/Docs wrappers.
bun docket smoke '<url-from-step-2>'

# 4. Register the doc as a project, then snapshot it into v1.
bun docket project create '<url-from-step-2>'
bun docket project list                # copy the project id from here
bun docket version create <project-id>
bun docket version list <project-id>   # copy the version id from here

# 5. Ingest Drive comments on that version into the canonical store.
bun docket comments ingest <version-id>
bun docket comments list <project-id>
```

Each `version create` copies the parent doc via Drive, names the copy `[Docket vN] <original>`, and stores a SHA-256 hash of the copy's plaintext as the snapshot fingerprint. `comments ingest` pulls Drive comments + replies, computes a canonical anchor (quoted text + paragraph hash + structural offset) against the version's doc, and is idempotent on re-run.

## Build phases

Tracking SPEC §12.

- [ ] **Phase 1** — core engine: project/version model, doc-copy + overlay application, canonical comment store, reanchoring engine, doc-watcher. CLI for testing.
  - [x] Drizzle schema for all 12 tables (§4)
  - [x] Envelope-encrypted refresh-token storage
  - [x] Google OAuth flow + `TokenProvider` with auto-refresh
  - [x] Drive + Docs API wrappers
  - [x] Project + Version primitives (creating projects from a parent doc, snapshotting versions)
  - [x] Canonical comment ingestion (Drive `comments.list` + Docs API tracked-change suggestions across body/headers/footers/footnotes → `canonical_comment` + `comment_projection`, idempotent)
  - [ ] Reanchoring engine
  - [ ] Overlay model + applier
  - [ ] Drive push-notification doc-watcher
  - [ ] Phase-1 CLI
- [ ] **Phase 2** — backend HTTP API + browser extension (capture) + minimal web entry points
  - [ ] `Bun.serve` HTTP API with per-user API tokens
  - [ ] OAuth callback + Drive Picker host page
  - [ ] Manifest V3 extension scaffold (Chrome/Edge/Firefox)
  - [ ] Sidebar `MutationObserver` + kix-discussion-id matching
  - [ ] Backend ingest endpoint resolving (docId, kix id) → suggestion's canonical_comment
  - [ ] Service-worker dedupe + retry queue
- [ ] **Phase 3** — Slack bot
- [ ] **Phase 4** — extension rich UI (dashboard, diff, reconciliation, overlay editor, settings) + magic-link action handlers — closes the MVP
- [ ] **Phase 5** — Workspace add-on
- [ ] **Phase 6** — cross-org polish + extension visualization (highlights, gutter, selection capture) + suggestion author/timestamp resolution
- [ ] **Phase 7** — Marketplace, advanced features

## Contributing

Project conventions, repo layout, schema-migration workflow, and test layout live in [`AGENTS.md`](./AGENTS.md).
