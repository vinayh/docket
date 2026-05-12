/**
 * Preload that runs BEFORE any test imports `src/db/client.ts`. We need to
 * pin `MARGIN_DB_PATH` to a per-process temp file before client.ts opens its
 * sqlite handle (the path is resolved at import time and never re-read), and
 * ensure `MARGIN_MASTER_KEY` + `BETTER_AUTH_SECRET` exist for the
 * envelope-encryption + Better Auth code paths respectively. The Google
 * OAuth client id/secret are read at module load by `src/auth/server.ts`
 * when constructing the Better Auth instance, so they need dummy defaults
 * too — tests never hit Google directly (live API coverage lives in the
 * `integration.yml` workflow, which injects real values).
 *
 * Migrations run here too, so any test can `import { db }` and start writing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tmp = mkdtempSync(resolve(tmpdir(), "margin-test-"));
Bun.env.MARGIN_DB_PATH = resolve(tmp, "test.db");

if (!Bun.env.MARGIN_MASTER_KEY) {
  Bun.env.MARGIN_MASTER_KEY = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
}

if (!Bun.env.BETTER_AUTH_SECRET) {
  Bun.env.BETTER_AUTH_SECRET = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
}

if (!Bun.env.GOOGLE_CLIENT_ID) Bun.env.GOOGLE_CLIENT_ID = "test-google-client-id";
if (!Bun.env.GOOGLE_CLIENT_SECRET) Bun.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { db } = await import("../src/db/client.ts");
migrate(db, { migrationsFolder: "./drizzle" });
