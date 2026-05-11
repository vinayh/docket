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
    get redirectUri() {
      return required("GOOGLE_REDIRECT_URI");
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
  dbPath: Bun.env.MARGIN_DB_PATH ?? "./margin.db",
  /**
   * Public origin of the Margin backend, e.g. `https://margin-server.fly.dev`.
   * Used to compute the Drive `files.watch` callback address and to decide
   * whether the auto-subscribe / renew loop should run. Null in dev unless
   * the operator opts in.
   */
  get publicBaseUrl() {
    return optional("MARGIN_PUBLIC_BASE_URL");
  },
};
