# Margin

[![codecov](https://codecov.io/gh/vinayh/margin/graph/badge.svg?token=V4MG527SMV)](https://codecov.io/gh/vinayh/margin)

Tracking comments on Google Docs with 'forks' (sidebar add-on, browser extension, and eventual Slack bot).

See [`SPEC.md`](./SPEC.md) for the full design and per-phase build status — [§12](./SPEC.md#12-build-sequence) tracks what's shipped, in-flight, and ahead.

## Stack

Bun runtime, `bun:sqlite` + Drizzle (Postgres later when we need multi-process), `Bun.serve()` for HTTP, WebCrypto AES-GCM envelope encryption for refresh tokens, `bun test` for tests. Conventions: [`AGENTS.md`](./AGENTS.md).

## Setup

1. **Install:**

   ```sh
   bun install
   ```

2. **Create a Google Cloud OAuth client.** In [console.cloud.google.com](https://console.cloud.google.com), create a project, enable the **Google Drive API**, **Google Docs API**, and **Google Picker API**, then create an OAuth 2.0 client (type: web application). Add `http://localhost:8787/api/auth/callback/google` as an authorized redirect URI (Better Auth's default callback path).

3. **Create a Picker API key.** In the same GCP project: APIs & Services → Credentials → "Create credentials" → API key. Restrict it to the Picker API. Note the GCP project number (Cloud Console → "Project info" → "Project number" — *not* the project ID).

4. **Generate two independent 32-byte base64 secrets** — one for envelope encryption of Google refresh tokens at rest, one for Better Auth (cookie HMAC + OAuth-state encryption). Run the one-liner twice:

   ```sh
   bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))'
   ```

5. **Create `.env`** by copying `.env.example` and filling in:

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_API_KEY=...                    # picker developer key (step 3)
   GOOGLE_PROJECT_NUMBER=...             # numeric project number (step 3)
   MARGIN_MASTER_KEY=<first base64 from step 4>
   BETTER_AUTH_SECRET=<second base64 from step 4>
   MARGIN_DB_PATH=./margin.db
   ```

   Bun loads `.env` automatically. The Picker vars are only required for the extension's "add doc" flow — the rest of the server works without them.

6. **Apply migrations:**

   ```sh
   bun migrate
   ```

## CLI

Run any subcommand with `bun margin <subcommand>`. The `--user <email>` flag selects which connected account acts as the doc owner; if omitted, the first user in the DB is used.

**Docs**

```
bun margin doc create [--title <t>] [--seed]              create a fresh Docs API doc
bun margin smoke <doc-url>                                getFile + copyFile + listComments
bun margin inspect <doc-url>                              dump raw Drive/Docs API responses
```

Sign-in happens in the browser extension (Options → "Sign in with Google"), not on the CLI — Better Auth handles the OAuth dance and stores the envelope-encrypted refresh token in `account.refresh_token`.

**Projects, versions, comments**

```
bun margin project create <doc-url> [--user <email>]      register a doc as a project
bun margin project list
bun margin version create <project-id> [--label v1]       snapshot the parent into a new version
bun margin version list <project-id>
bun margin comments ingest <version-id>                   pull Drive comments into the canonical store
bun margin comments list <project-id>
bun margin reanchor <target-version-id>                   project canonical comments onto a version
```

**Overlays & derivatives**

```
bun margin overlay create <project-id> --name <name>      register a new overlay
bun margin overlay list <project-id>
bun margin overlay add-op <overlay-id> --type ...         append an op (redact|replace|insert|append)
bun margin overlay ops <overlay-id>
bun margin overlay apply <overlay-id> --version <id>      copy + apply overlay → derivative doc
bun margin derivative list <project-id>
```

**Watcher (Drive push notifications)**

```
bun margin watcher subscribe <version-id> --address ...   subscribe drive.files.watch on a version
bun margin watcher list
bun margin watcher unsubscribe <channel-row-id>
bun margin watcher renew                                  renew channels nearing expiration
bun margin watcher poll                                   polling fallback: re-ingest active versions
bun margin watcher simulate <channel-id> [--state ...]    exercise the push handler locally
```

**Server**

```
bun margin serve [--port <n>]                             start the HTTP API (Bun.serve)
```

## Validate the backend

After [Setup](#setup), connect a real Google account and exercise the full backend stack:

```sh
# 1. Build and load the browser extension (see "Test the browser extension"
#    below), then click "Sign in with Google" on its Options page. Better
#    Auth handles the OAuth dance and stores the envelope-encrypted refresh
#    token in `account.refresh_token`.

# 2. Create a fresh doc to test against.
#    drive.file access is granted automatically because the OAuth client created the file.
#    For pre-existing docs you own, use the Drive Picker entry — see "Track an
#    existing doc via the Drive Picker" below.
bun margin doc create --seed
# -> created doc <doc-id>
#    url: https://docs.google.com/document/d/<doc-id>/edit
# Open the URL and add a few comments by highlighting text and clicking "Comment".

# 3. Sanity-check the Drive/Docs wrappers.
bun margin smoke '<url-from-step-2>'

# 4. Register the doc as a project, then snapshot it into v1.
bun margin project create '<url-from-step-2>'
bun margin project list                # copy the project id
bun margin version create <project-id>
bun margin version list <project-id>   # copy the version id

# 5. Ingest Drive comments on that version into the canonical store.
bun margin comments ingest <version-id>
bun margin comments list <project-id>
```

`version create` copies the parent doc via Drive, names the copy `[Margin vN] <original>`, and stores a SHA-256 hash of the copy's plaintext as the snapshot fingerprint. `comments ingest` pulls Drive comments + replies, computes a canonical anchor (quoted text + paragraph hash + structural offset) against the version's doc, and is idempotent on re-run.

## Track an existing doc via the Drive Picker

The Picker is the only mechanism that grants `drive.file` access to a doc the OAuth client didn't create (SPEC §9.2). Open any Google Doc, click the Margin toolbar icon, click **Add to Margin** — the backend-hosted Picker (`/api/picker/page`) opens in a new tab. Pick the doc; the page POSTs to `/api/picker/register-doc` and auto-closes. Works on Chromium and Firefox.

## Test the browser extension

The MV3 extension lives in [`surfaces/extension/`](./surfaces/extension/) — its [README](./surfaces/extension/README.md) covers build, layout, popup state machine, and OAuth/Picker mechanics. End-to-end smoke test:

1. Start the backend: `bun margin serve` (defaults to `http://localhost:8787`).
2. Build and load the extension:
   - **Chrome / Edge:** `bun run ext:build` → `chrome://extensions` → Developer Mode → **Load unpacked** → `surfaces/extension/dist/chrome-mv3`.
   - **Firefox:** `bun run ext:build:firefox` → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → any file inside `surfaces/extension/dist/firefox-mv3` (e.g. `manifest.json`).
3. Open the extension's **Options** page, enter the backend URL, click **Test connection** (Chrome will prompt for the backend origin — approve), then **Save backend URL**.
4. Click **Sign in with Google**. The Options page opens a top-level tab at `/api/auth/ext/launch-tab`; after Google's consent screen, the bridge page hands the session token to the SW and closes itself.
5. Open a Google Doc, click the toolbar icon → **Add to Margin**. The Picker tab opens; pick the doc and the page registers it as a project. `bun margin comments list <project-id>` will show ingested comments after the first webhook fires (or `bun margin watcher poll` to force-pull).

## Deployment (Fly.io)

The repo deploys as a single-region Fly.io app — see `Dockerfile` + `fly.toml`. Multi-stage Bun-on-Alpine image, 1GB volume mounted at `/data` for the SQLite file, `/healthz` check on `bun margin serve`. When `MARGIN_PUBLIC_BASE_URL` is set (it is, in `fly.toml`), the running server also auto-subscribes a Drive `files.watch` channel on every new version and runs the renew (~30 min) + polling (~10 min) loops in-process — no separate cron container needed.

**Initial setup (once per deployment):**

1. `flyctl apps create <your-app-name>` — names are global on Fly.
2. `flyctl volumes create margin_data --app <your-app-name> --region <region> --size 1` (e.g. `--region lhr`).
3. Edit `fly.toml`: set `app` and `primary_region` to match.
4. In Google Cloud Console, create a *separate* OAuth client for production (don't reuse the local one) and add `https://<your-public-host>/api/auth/callback/google` to its authorized redirect URIs (Margin's own deployment runs at `https://api.margin.pub`). Create a Picker API key in the same project (restrict to Picker API) and note the project number.
5. Update `fly.toml`'s `MARGIN_PUBLIC_BASE_URL` to match your app hostname.
6. Set the Fly secrets — the master-key generator is piped inline so the value never appears in your terminal:

   ```sh
   flyctl secrets set --app <your-app-name> \
     GOOGLE_CLIENT_ID='<prod-client-id>' \
     GOOGLE_CLIENT_SECRET='<prod-client-secret>' \
     GOOGLE_API_KEY='<picker-api-key>' \
     GOOGLE_PROJECT_NUMBER='<gcp-project-number>' \
     MARGIN_MASTER_KEY="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')" \
     BETTER_AUTH_SECRET="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')"
   ```

   Stash the master key in a password manager too — losing it makes existing encrypted refresh tokens unrecoverable. `BETTER_AUTH_SECRET` is rotatable (rotating it invalidates active sessions but doesn't lose data) and MUST be different from `MARGIN_MASTER_KEY` so that compromise of one doesn't cascade into the other.

7. `flyctl deploy --remote-only` for the first deploy.

**Auto-deploy via GitHub Actions.** `.github/workflows/ci.yml` runs on every push to `main`: typecheck → `bun test` (with coverage upload) → `flyctl deploy --remote-only`. Add the deploy token as the `FLY_API_TOKEN` repo secret:

```sh
flyctl tokens create deploy --app <your-app-name> --expiry 8760h \
  | gh secret set FLY_API_TOKEN --repo <owner>/<repo> --body-file -
```

**Verify a deploy:**

```sh
curl https://<your-public-host>/healthz   # → {"ok":true}  (Margin: https://api.margin.pub/healthz)
```

For an end-to-end OAuth round-trip, point the extension's Backend URL at `https://<your-public-host>` (Margin: `https://api.margin.pub`), click **Test connection** (grant the origin), then **Sign in with Google** — Better Auth runs the consent flow and the extension surface should flip to "Signed in".

## CI & test tiers

`bun test` runs every test in the repo. CI splits them across two GitHub Actions workflows:

| Workflow | Trigger | What it runs | Codecov flag |
|---|---|---|---|
| `.github/workflows/ci.yml` | Every push + PR | Typecheck, `bun test` (mocked transports + temp-DB), Fly deploy on `main`. Integration tests skip cleanly when the secrets below aren't set. | `unit` |
| `.github/workflows/integration.yml` | `workflow_dispatch` + nightly cron (07:00 UTC) | Live Google integration tests (`*.integration.test.ts`). | `integration` |

Codecov merges both flagged uploads into the project total — see `codecov.yml`. The dashboard lets you filter by flag.

### Configuring the integration-test secrets

The integration workflow needs four GitHub repo secrets. **Until they're set the workflow still passes**: `integrationTest()` (in `test/integration.ts`) skips every body when any required env var is missing. Adding the secrets is what flips the suite from "skipped" to "actually exercises Google."

Set these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Source |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from your GCP project (Credentials page). Reuse your prod client or create a separate "Margin CI" client. |
| `GOOGLE_CLIENT_SECRET` | The secret paired with the client id above. |
| `GOOGLE_CI_REFRESH_TOKEN` | A long-lived refresh token issued for a dedicated test Google account. See below. |
| `MARGIN_MASTER_KEY` | A 32-byte base64 envelope-encryption key. The integration job has its own ephemeral DB, so the value doesn't have to match anything else. Generate with the same one-liner from [Setup §4](#setup). |

`CODECOV_TOKEN` is already required by `ci.yml`; the integration workflow reuses the same secret.

**Minting `GOOGLE_CI_REFRESH_TOKEN`:**

1. Create a dedicated test Google account (`margin-ci@…`). Don't use your personal account — integration tests will create real Drive files.
2. In GCP Console → APIs & Services → OAuth consent screen, add the CI account under **Test users** so consent goes through without app verification.
3. Run the OAuth flow once locally as the CI account:

   ```sh
   bun margin serve
   # then load the extension, set Backend URL = http://localhost:8787,
   # click "Sign in with Google" with the CI account.
   ```

   On approval Better Auth upserts a `user` row, a `session` row, and an `account` row whose `refresh_token` is envelope-encrypted.

4. Decrypt the stored refresh token (uses the same `MARGIN_MASTER_KEY` that wrote it):

   ```sh
   bun -e 'import("./src/auth/encryption.ts").then(async ({decryptWithMaster}) => { const {db} = await import("./src/db/client.ts"); const {account} = await import("./src/db/schema.ts"); const {eq} = await import("drizzle-orm"); const r = (await db.select().from(account).where(eq(account.providerId, "google")))[0]; console.log(await decryptWithMaster(r.refreshToken)); })'
   ```

   Paste the printed string into `GOOGLE_CI_REFRESH_TOKEN`.

The token is long-lived as long as the CI account stays in **Test users** and the consent isn't revoked. Nightly cron runs keep it warm; if it ever stops working, re-run the consent flow and replace the secret.

**Verifying the workflow:** GitHub → Actions → **Integration** → **Run workflow**. The smoke test (`refresh_token grants an access token`) should pass in under a minute. Codecov will then show two flags (`unit` + `integration`) on the dashboard.

### Adding more integration tests

Drop additional `*.integration.test.ts` files anywhere under `test/`, wrap each test body with `integrationTest()` from `test/integration.ts`, and update `package.json`'s `test:integration` script to widen the path glob if it grows beyond the current single file. They run in the same nightly job and contribute to the `integration` codecov flag.

The deliberate split: tier 1 unit tests (transport-faked, temp-DB-backed) catch *our own* logic regressions on every push; tier 3 integration tests catch *Google-side* drift on a cadence we control. Adding mocked-fetch tests for Google response shapes (a notional "tier 2") was considered and rejected — fixtures rot silently and the live integration suite already covers that ground.

## Contributing

Project conventions, repo layout, schema-migration workflow, and test layout live in [`AGENTS.md`](./AGENTS.md).
