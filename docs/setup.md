# Setup

Local development setup for Margin. For deployment to Fly.io see [`deployment.md`](./deployment.md). For CI / integration-test secrets see [`testing.md`](./testing.md).

## Install + configure

1. **Install:**

   ```sh
   bun install
   ```

2. **Create a Google Cloud OAuth client.** In [console.cloud.google.com](https://console.cloud.google.com), create a project, enable the **Google Drive API**, **Google Docs API**, and **Google Picker API**, then create an OAuth 2.0 client (type: web application). Add `http://localhost:8787/api/auth/callback/google` as an authorized redirect URI (Better Auth's default callback path).

3. **Create a Picker API key.** In the same GCP project: APIs & Services → Credentials → "Create credentials" → API key. Restrict it to the Picker API. Note the GCP project number (Cloud Console → "Project info" → "Project number", *not* the project ID).

4. **Generate two independent 32-byte base64 secrets.** One for envelope encryption of Google refresh tokens at rest, one for Better Auth (cookie HMAC + OAuth-state encryption). Run the one-liner twice:

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

   Bun loads `.env` automatically. The Picker vars are only required for the extension's "add doc" flow. The rest of the server works without them.

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

Sign-in happens in the browser extension (Options → "Sign in with Google"), not on the CLI. Better Auth handles the OAuth dance and stores the envelope-encrypted refresh token in `account.refresh_token`.

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

## Validate the backend end-to-end

After the steps above, connect a real Google account and exercise the full backend stack:

```sh
# 1. Build and load the browser extension (see "Test the browser extension"
#    below), then click "Sign in with Google" on its Options page. Better
#    Auth handles the OAuth dance and stores the envelope-encrypted refresh
#    token in `account.refresh_token`.

# 2. Create a fresh doc to test against.
#    drive.file access is granted automatically because the OAuth client created the file.
#    For pre-existing docs you own, use the Drive Picker entry; see "Track an
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

The Picker is the only mechanism that grants `drive.file` access to a doc the OAuth client didn't create ([`spec.md` §9.2](./spec.md#92-drivefile-scope)). Open any Google Doc, click the Margin toolbar icon, click **Add to Margin**. The backend-hosted Picker (`/api/picker/page`) opens in a new tab. Pick the doc; the page POSTs to `/api/picker/register-doc` and auto-closes. Works on Chromium and Firefox.

## Test the browser extension

The MV3 extension lives in [`surfaces/extension/`](../surfaces/extension/); its [README](../surfaces/extension/README.md) covers build, layout, popup state machine, and OAuth/Picker mechanics. End-to-end smoke test:

1. Start the backend: `bun margin serve` (defaults to `http://localhost:8787`).
2. Build and load the extension:
   - **Chrome / Edge:** `bun run ext:build` → `chrome://extensions` → Developer Mode → **Load unpacked** → `surfaces/extension/dist/chrome-mv3`.
   - **Firefox:** `bun run ext:build:firefox` → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → any file inside `surfaces/extension/dist/firefox-mv3` (e.g. `manifest.json`).
3. Open the extension's **Options** page, enter the backend URL, click **Test connection** (Chrome will prompt for the backend origin; approve), then **Save backend URL**.
4. Click **Sign in with Google**. The Options page opens a top-level tab at `/api/auth/ext/launch-tab`; after Google's consent screen, the bridge page hands the session token to the SW and closes itself.
5. Open a Google Doc, click the toolbar icon → **Add to Margin**. The Picker tab opens; pick the doc and the page registers it as a project. `bun margin comments list <project-id>` will show ingested comments after the first webhook fires (or `bun margin watcher poll` to force-pull).
