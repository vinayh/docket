# Docket

[![codecov](https://codecov.io/gh/vinayh/docket/graph/badge.svg?token=V4MG527SMV)](https://codecov.io/gh/vinayh/docket)

Tracking comments on Google Docs with 'forks' (sidebar add-on, browser extension, and eventual Slack bot).

See [`SPEC.md`](./SPEC.md) for the full design and per-phase build status — [§12](./SPEC.md#12-build-sequence) tracks what's shipped, in-flight, and ahead.

## Stack

- Runtime: Bun
- DB: `bun:sqlite` + Drizzle ORM (Postgres later, when we need multi-process)
- HTTP: `Bun.serve()` (no Express)
- Encryption: WebCrypto AES-GCM, envelope-style for refresh tokens
- Tests: `bun test`

## Setup

1. **Install:**

   ```sh
   bun install
   ```

2. **Create a Google Cloud OAuth client.** In [console.cloud.google.com](https://console.cloud.google.com), create a project, enable the **Google Drive API** and **Google Docs API**, then create an OAuth 2.0 client (type: web application). Add `http://localhost:8787/oauth/callback` as an authorized redirect URI.

3. **Generate a master key** for envelope encryption (32 bytes, base64-encoded):

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

Run any subcommand with `bun docket <subcommand>`. The `--user <email>` flag selects which connected account acts as the doc owner; if omitted, the first user in the DB is used.

**Auth & docs**

```
bun docket connect                                        connect a Google account
bun docket doc create [--title <t>] [--seed]              create a fresh Docs API doc
bun docket smoke <doc-url>                                getFile + copyFile + listComments
bun docket inspect <doc-url>                              dump raw Drive/Docs API responses
```

**Projects, versions, comments**

```
bun docket project create <doc-url> [--user <email>]      register a doc as a project
bun docket project list
bun docket version create <project-id> [--label v1]       snapshot the parent into a new version
bun docket version list <project-id>
bun docket comments ingest <version-id>                   pull Drive comments into the canonical store
bun docket comments list <project-id>
bun docket reanchor <target-version-id>                   project canonical comments onto a version
```

**Overlays & derivatives**

```
bun docket overlay create <project-id> --name <name>      register a new overlay
bun docket overlay list <project-id>
bun docket overlay add-op <overlay-id> --type ...         append an op (redact|replace|insert|append)
bun docket overlay ops <overlay-id>
bun docket overlay apply <overlay-id> --version <id>      copy + apply overlay → derivative doc
bun docket derivative list <project-id>
```

**Watcher (Drive push notifications)**

```
bun docket watcher subscribe <version-id> --address ...   subscribe drive.files.watch on a version
bun docket watcher list
bun docket watcher unsubscribe <channel-row-id>
bun docket watcher renew                                  renew channels nearing expiration
bun docket watcher poll                                   polling fallback: re-ingest active versions
bun docket watcher simulate <channel-id> [--state ...]    exercise the push handler locally
```

**Server & API tokens**

```
bun docket serve [--port <n>]                             start the HTTP API (Bun.serve)
bun docket token issue [--user <email>] [--label <l>]     issue an API token (shown once)
bun docket token list  [--user <email>]                   list active tokens
bun docket token revoke <token-id>                        revoke an active token
```

## Validate the backend

After [Setup](#setup), connect a real Google account and exercise the full backend stack:

```sh
# 1. Connect a Google account.
#    Opens a consent URL; the local callback server captures the code,
#    upserts a user row, and stores an encrypted refresh token.
bun docket connect

# 2. Create a fresh doc to test against.
#    drive.file access is granted automatically because the OAuth client created the file.
#    A pre-existing doc you own won't work yet; the Drive Picker (Phase 2) and
#    Workspace Add-on (Phase 3) are the other entry points (SPEC §9.2).
bun docket doc create --seed
# -> created doc <doc-id>
#    url: https://docs.google.com/document/d/<doc-id>/edit
# Open the URL and add a few comments by highlighting text and clicking "Comment".

# 3. Sanity-check the Drive/Docs wrappers.
bun docket smoke '<url-from-step-2>'

# 4. Register the doc as a project, then snapshot it into v1.
bun docket project create '<url-from-step-2>'
bun docket project list                # copy the project id
bun docket version create <project-id>
bun docket version list <project-id>   # copy the version id

# 5. Ingest Drive comments on that version into the canonical store.
bun docket comments ingest <version-id>
bun docket comments list <project-id>
```

`version create` copies the parent doc via Drive, names the copy `[Docket vN] <original>`, and stores a SHA-256 hash of the copy's plaintext as the snapshot fingerprint. `comments ingest` pulls Drive comments + replies, computes a canonical anchor (quoted text + paragraph hash + structural offset) against the version's doc, and is idempotent on re-run.

## Test the browser extension

The Phase-2 capture extension (Manifest V3, Chrome / Edge / Firefox) lives in [`surfaces/extension/`](./surfaces/extension/) — its [README](./surfaces/extension/README.md) covers the build pipeline and the DOM-selector maintenance contract. End-to-end test flow:

1. **Start the backend** in one terminal:

   ```sh
   bun docket serve
   # -> docket api listening on http://localhost:8787
   ```

2. **Connect a Google account** (skip if already done — check `bun docket project list` etc.):

   ```sh
   bun docket connect
   ```

3. **Issue an API token** for the extension:

   ```sh
   bun docket token issue --user <your-email> --label "local-dev"
   # -> token: dkt_...   (copy this — shown once)
   ```

4. **Build the extension** and load it unpacked:

   ```sh
   bun run surfaces/extension/build.ts
   ```

   - **Chrome / Edge:** `chrome://extensions` → enable Developer Mode → **Load unpacked** → pick `surfaces/extension/dist/chromium`.
   - **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick any file inside `surfaces/extension/dist/firefox` (e.g. `manifest.json`).

5. **Configure the extension.** Open its **Options** page (right-click toolbar icon → Options, or `chrome://extensions` → Details → Extension options). Enter:
   - **Backend URL:** `http://localhost:8787`
   - **API token:** the `dkt_...` value from step 3

   Click **Test connection** — Chrome will prompt you to grant access to the backend's origin (the manifest declares `optional_host_permissions: ["<all_urls>"]` and the extension requests the specific origin you typed; this is what lets a single build hit both `localhost` and your Fly app). Approve, then **Save**.

6. **Create a test doc and register it** as a project + version (the extension only ingests captures for docs Docket already knows about):

   ```sh
   bun docket doc create --seed
   # -> open the printed URL in Chrome
   bun docket project create '<doc-url>'
   bun docket version create <project-id>
   ```

7. **Add a suggestion reply.** In the doc, switch to **Suggesting** mode (top-right pencil menu → Suggesting), edit some text to create a suggestion, then open the discussion sidebar and type a reply on that suggestion's card. The content script scrapes the sidebar on DOM-mutation settle (~750 ms debounce).

8. **Flush and verify.** Click the extension's toolbar icon → **Flush queue now** (otherwise the alarm-driven flush runs every ~60 s). Then:

   ```sh
   bun docket comments list <project-id>
   # -> should now show the scraped reply alongside any native Drive comments
   ```

   The popup shows queue size + last error if anything failed. The doc tab's DevTools console will print one `[docket] content script ready (doc=...)` line on load and a one-line first-scan summary (`threads=N suggestions=N captures=N fresh=N`) — useful for confirming the scraper is alive when nothing's being captured. The SW console (`chrome://extensions` → **Inspect views: service worker**) has the network-side detail.

**Caveats during this phase.**

- Only replies on *suggestion* threads are captured — regular comments come through Drive's API (see [`SPEC.md` §11](./SPEC.md#11-out-of-scope-for-v1)).
- After clicking the **reload icon** on `chrome://extensions`, the *open doc tab* still runs the previously injected content script. Hard-refresh the tab (Cmd-Shift-R / Ctrl-Shift-R) to pick up the new build.
- Selectors are tolerant but Docs reships the sidebar UI ~quarterly and failures are silent. See the extension [README](./surfaces/extension/README.md#dom-selector-maintenance) for the maintenance contract.

## Deployment (Fly.io)

The repo deploys as a single-region Fly.io app — see `Dockerfile` + `fly.toml`. Multi-stage Bun-on-Alpine image, 1GB volume mounted at `/data` for the SQLite file, `/healthz` check on `bun docket serve`.

**Initial setup (once per deployment):**

1. `flyctl apps create <your-app-name>` — names are global on Fly.
2. `flyctl volumes create docket_data --app <your-app-name> --region <region> --size 1` (e.g. `--region lhr`).
3. Edit `fly.toml`: set `app` and `primary_region` to match.
4. In Google Cloud Console, create a *separate* OAuth client for production (don't reuse the local one) and add `https://<your-app-name>.fly.dev/oauth/callback` to its authorized redirect URIs.
5. Set the Fly secrets — the master-key generator is piped inline so the value never appears in your terminal:

   ```sh
   flyctl secrets set --app <your-app-name> \
     GOOGLE_CLIENT_ID='<prod-client-id>' \
     GOOGLE_CLIENT_SECRET='<prod-client-secret>' \
     GOOGLE_REDIRECT_URI='https://<your-app-name>.fly.dev/oauth/callback' \
     DOCKET_MASTER_KEY="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')"
   ```

   Stash the master key in a password manager too — losing it makes existing encrypted refresh tokens unrecoverable.

6. `flyctl deploy --remote-only` for the first deploy.

**Auto-deploy via GitHub Actions.** `.github/workflows/fly-deploy.yml` runs on every push to `main`: typecheck → `bun test` → `flyctl deploy --remote-only`. Add the deploy token as the `FLY_API_TOKEN` repo secret:

```sh
flyctl tokens create deploy --app <your-app-name> --expiry 8760h \
  | gh secret set FLY_API_TOKEN --repo <owner>/<repo> --body-file -
```

**Verify a deploy:**

```sh
curl https://<your-app-name>.fly.dev/healthz   # → {"ok":true}
```

For an end-to-end OAuth round-trip, open `https://<your-app-name>.fly.dev/oauth/start` in a browser, approve consent, and you should land on the callback page with `Connected <email> as new user. You can close this tab.`

## Contributing

Project conventions, repo layout, schema-migration workflow, and test layout live in [`AGENTS.md`](./AGENTS.md).
