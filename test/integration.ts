import { test } from "bun:test";

/**
 * Integration tests run against real Google APIs. They're gated on a
 * pre-issued OAuth refresh token + the rest of the OAuth client config so
 * unit-test runs (and fresh forks) don't fail when the secrets aren't set.
 *
 * Use `integrationTest` in place of `test` inside `*.integration.test.ts`
 * files; the body runs only when every gate-var is present.
 */
const REQUIRED_VARS = [
  "GOOGLE_CI_REFRESH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

function missingVars(): string[] {
  return REQUIRED_VARS.filter((k) => !Bun.env[k]);
}

export const hasIntegrationCreds = missingVars().length === 0;

export const integrationTest = (
  name: string,
  body: () => void | Promise<void>,
  timeoutMs?: number,
) => {
  if (hasIntegrationCreds) return test(name, body, timeoutMs);
  const missing = missingVars().join(", ");
  return test.skip(`${name} (skipped: missing ${missing})`, body, timeoutMs);
};
