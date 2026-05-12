function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function optional(name: string): string | null {
  const value = Bun.env[name];
  return value && value.length > 0 ? value : null;
}

export const config = {
  google: {
    get clientId() {
      return required("GOOGLE_CLIENT_ID");
    },
    get clientSecret() {
      return required("GOOGLE_CLIENT_SECRET");
    },
    /**
     * Drive Picker requires a public API key (developer key) and the GCP
     * project number (`appId`), separate from the OAuth client credentials.
     * Lazy + nullable so the server still boots without them; the picker
     * page renders an explanatory error when either is missing.
     */
    get apiKey() {
      return optional("GOOGLE_API_KEY");
    },
    get projectNumber() {
      return optional("GOOGLE_PROJECT_NUMBER");
    },
  },
  get masterKeyB64() {
    return required("MARGIN_MASTER_KEY");
  },
  /**
   * Better Auth signing/encryption secret. Distinct from `MARGIN_MASTER_KEY`
   * so a compromise of one layer (cookie signing vs. refresh-token-at-rest
   * encryption) doesn't cascade into the other.
   */
  get betterAuthSecret() {
    return required("BETTER_AUTH_SECRET");
  },
  dbPath: Bun.env.MARGIN_DB_PATH ?? "./margin.db",
  /**
   * Public origin of the Margin backend, e.g. `https://api.margin.pub`.
   * Used to compute the Drive `files.watch` callback address and to decide
   * whether the auto-subscribe / renew loop should run. Null in dev unless
   * the operator opts in.
   */
  get publicBaseUrl() {
    return optional("MARGIN_PUBLIC_BASE_URL");
  },
  /**
   * Gate for the `bun margin e2e seed-project` CLI. Must equal "1" for the
   * seed to proceed — the seeder bypasses Drive validation and would shred a
   * prod DB if invoked by accident. Set in the test harness shell only.
   */
  get allowE2eSeed() {
    return Bun.env.MARGIN_ALLOW_E2E_SEED === "1";
  },
  /**
   * Default user email for `bun margin e2e seed-project` when the operator
   * doesn't pass `--user`. The user must already exist (run `bun margin
   * connect` once with that account).
   */
  get testUserEmail() {
    return optional("MARGIN_TEST_USER_EMAIL");
  },
};
