# CI & test tiers

`bun test` runs every test in the repo. CI splits them across two GitHub Actions workflows:

| Workflow | Trigger | What it runs | Codecov flag |
|---|---|---|---|
| `.github/workflows/ci.yml` | Every push + PR | Typecheck, `bun test` (mocked transports + temp-DB), Fly deploy on `main`. Integration tests skip cleanly when the secrets below aren't set. | `unit` |
| `.github/workflows/integration.yml` | `workflow_dispatch` + nightly cron (07:00 UTC) | Live Google integration tests (`*.integration.test.ts`). | `integration` |

Codecov merges both flagged uploads into the project total (see `codecov.yml`). The dashboard lets you filter by flag.

## Configuring the integration-test secrets

The integration workflow needs four GitHub repo secrets. **Until they're set the workflow still passes**: `integrationTest()` (in `test/integration.ts`) skips every body when any required env var is missing. Adding the secrets is what flips the suite from "skipped" to "actually exercises Google."

Set these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Source |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from your GCP project (Credentials page). Reuse your prod client or create a separate "Margin CI" client. |
| `GOOGLE_CLIENT_SECRET` | The secret paired with the client id above. |
| `GOOGLE_CI_REFRESH_TOKEN` | A long-lived refresh token issued for a dedicated test Google account. See below. |
| `MARGIN_MASTER_KEY` | A 32-byte base64 envelope-encryption key. The integration job has its own ephemeral DB, so the value doesn't have to match anything else. Generate with the same one-liner from [`setup.md` §4](./setup.md#install--configure). |

`CODECOV_TOKEN` is already required by `ci.yml`; the integration workflow reuses the same secret.

**Minting `GOOGLE_CI_REFRESH_TOKEN`:**

1. Create a dedicated test Google account (`margin-ci@…`). Don't use your personal account; integration tests will create real Drive files.
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

## Adding more integration tests

Drop additional `*.integration.test.ts` files anywhere under `test/`, wrap each test body with `integrationTest()` from `test/integration.ts`, and update `package.json`'s `test:integration` script to widen the path glob if it grows beyond the current single file. They run in the same nightly job and contribute to the `integration` codecov flag.

The split is intentional. Tier 1 unit tests (transport-faked, temp-DB-backed) catch *our own* logic regressions on every push; tier 3 integration tests catch *Google-side* drift on a cadence we control. Mocked-fetch tests for Google response shapes (a notional "tier 2") were considered and rejected: fixtures rot silently, and the live integration suite already covers the same ground.
