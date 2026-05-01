function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
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
  },
  get masterKeyB64() {
    return required("DOCKET_MASTER_KEY");
  },
  dbPath: Bun.env.DOCKET_DB_PATH ?? "./docket.db",
};
