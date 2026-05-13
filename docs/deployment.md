# Deployment (Fly.io)

The repo deploys as a single-region Fly.io app (see `Dockerfile` + `fly.toml`). Multi-stage Bun-on-Alpine image, 1GB volume mounted at `/data` for the SQLite file, `/healthz` check on `bun margin serve`. When `MARGIN_PUBLIC_BASE_URL` is set (it is, in `fly.toml`), the running server also auto-subscribes a Drive `files.watch` channel on every new version and runs the renew (~30 min) + polling (~10 min) loops in-process; no separate cron container needed.

## Initial setup (once per deployment)

1. `flyctl apps create <your-app-name>` (names are global on Fly).
2. `flyctl volumes create margin_data --app <your-app-name> --region <region> --size 1` (e.g. `--region lhr`).
3. Edit `fly.toml`: set `app` and `primary_region` to match.
4. In Google Cloud Console, create a *separate* OAuth client for production (don't reuse the local one) and add `https://<your-public-host>/api/auth/callback/google` to its authorized redirect URIs (Margin's own deployment runs at `https://api.margin.pub`). Create a Picker API key in the same project (restrict to Picker API) and note the project number.
5. Update `fly.toml`'s `MARGIN_PUBLIC_BASE_URL` to match your app hostname.
6. Set the Fly secrets. The master-key generator is piped inline so the value never appears in your terminal:

   ```sh
   flyctl secrets set --app <your-app-name> \
     GOOGLE_CLIENT_ID='<prod-client-id>' \
     GOOGLE_CLIENT_SECRET='<prod-client-secret>' \
     GOOGLE_API_KEY='<picker-api-key>' \
     GOOGLE_PROJECT_NUMBER='<gcp-project-number>' \
     MARGIN_MASTER_KEY="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')" \
     BETTER_AUTH_SECRET="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')"
   ```

   Stash the master key in a password manager too; losing it makes existing encrypted refresh tokens unrecoverable. `BETTER_AUTH_SECRET` is rotatable (rotating it invalidates active sessions but doesn't lose data) and MUST be different from `MARGIN_MASTER_KEY` so that compromise of one doesn't cascade into the other.

7. `flyctl deploy --remote-only` for the first deploy.

## Auto-deploy via GitHub Actions

`.github/workflows/ci.yml` runs on every push to `main`: typecheck → `bun test` (with coverage upload) → `flyctl deploy --remote-only`. Add the deploy token as the `FLY_API_TOKEN` repo secret:

```sh
flyctl tokens create deploy --app <your-app-name> --expiry 8760h \
  | gh secret set FLY_API_TOKEN --repo <owner>/<repo> --body-file -
```

## Verify a deploy

```sh
curl https://<your-public-host>/healthz   # → {"ok":true}  (Margin: https://api.margin.pub/healthz)
```

For an end-to-end OAuth round-trip, point the extension's Backend URL at `https://<your-public-host>` (Margin: `https://api.margin.pub`), click **Test connection** (grant the origin), then **Sign in with Google**. Better Auth runs the consent flow and the extension surface should flip to "Signed in".
