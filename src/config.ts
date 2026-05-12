import * as v from "valibot";

function envValue(name: string): string | null {
  const value = Bun.env[name];
  return value && value.length > 0 ? value : null;
}

/**
 * Parse an env var through a valibot schema, throwing a descriptive error on
 * failure. Use this from a lazy getter so config errors surface at first
 * access (boot for required keys, on-demand for optional ones) rather than
 * at the first crypto operation or Drive call.
 */
function parseEnv<TSchema extends v.GenericSchema>(
  name: string,
  schema: TSchema,
  raw: string | null,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, raw);
  if (result.success) return result.output;
  const issue = result.issues[0];
  throw new Error(`invalid env var ${name}: ${issue.message}`);
}

// Master encryption key — base64 of exactly 32 bytes (AES-256-GCM).
const MasterKeySchema = v.pipe(
  v.string("MARGIN_MASTER_KEY is required"),
  v.minLength(1, "MARGIN_MASTER_KEY is required"),
  v.check((s) => {
    try {
      return Buffer.from(s, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be base64 of 32 bytes"),
);

const BetterAuthSecretSchema = v.pipe(
  v.string("BETTER_AUTH_SECRET is required"),
  v.minLength(32, "must be at least 32 chars"),
);

const RequiredStringSchema = v.pipe(v.string(), v.minLength(1));

const OptionalUrlSchema = v.union([
  v.null(),
  v.pipe(v.string(), v.url("must be an absolute URL")),
]);

const OptionalEmailSchema = v.union([
  v.null(),
  v.pipe(v.string(), v.email("must be a valid email")),
]);

const OptionalStringSchema = v.union([v.null(), v.pipe(v.string(), v.minLength(1))]);

export const config = {
  google: {
    get clientId() {
      return parseEnv("GOOGLE_CLIENT_ID", RequiredStringSchema, envValue("GOOGLE_CLIENT_ID"));
    },
    get clientSecret() {
      return parseEnv(
        "GOOGLE_CLIENT_SECRET",
        RequiredStringSchema,
        envValue("GOOGLE_CLIENT_SECRET"),
      );
    },
    /**
     * Drive Picker requires a public API key (developer key) and the GCP
     * project number (`appId`), separate from the OAuth client credentials.
     * Lazy + nullable so the server still boots without them; the picker
     * page renders an explanatory error when either is missing.
     */
    get apiKey() {
      return parseEnv("GOOGLE_API_KEY", OptionalStringSchema, envValue("GOOGLE_API_KEY"));
    },
    get projectNumber() {
      return parseEnv(
        "GOOGLE_PROJECT_NUMBER",
        OptionalStringSchema,
        envValue("GOOGLE_PROJECT_NUMBER"),
      );
    },
  },
  get masterKeyB64() {
    return parseEnv("MARGIN_MASTER_KEY", MasterKeySchema, envValue("MARGIN_MASTER_KEY"));
  },
  /**
   * Better Auth signing/encryption secret. Distinct from `MARGIN_MASTER_KEY`
   * so a compromise of one layer (cookie signing vs. refresh-token-at-rest
   * encryption) doesn't cascade into the other.
   */
  get betterAuthSecret() {
    return parseEnv(
      "BETTER_AUTH_SECRET",
      BetterAuthSecretSchema,
      envValue("BETTER_AUTH_SECRET"),
    );
  },
  dbPath: Bun.env.MARGIN_DB_PATH ?? "./margin.db",
  /**
   * Public origin of the Margin backend, e.g. `https://api.margin.pub`.
   * Used to compute the Drive `files.watch` callback address and to decide
   * whether the auto-subscribe / renew loop should run. Null in dev unless
   * the operator opts in.
   */
  get publicBaseUrl() {
    return parseEnv(
      "MARGIN_PUBLIC_BASE_URL",
      OptionalUrlSchema,
      envValue("MARGIN_PUBLIC_BASE_URL"),
    );
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
   * When "1", trust the upstream proxy's `Fly-Client-IP` / `X-Forwarded-For`
   * headers as the client IP (rate-limit bucket key). Off by default — without
   * an upstream proxy, those headers are attacker-controlled and would let
   * a client spoof an arbitrary bucket key. The Fly deployment sets this.
   */
  get trustProxy() {
    return Bun.env.MARGIN_TRUST_PROXY === "1";
  },
  /**
   * Default user email for `bun margin e2e seed-project` when the operator
   * doesn't pass `--user`. The user must already exist (run `bun margin
   * connect` once with that account).
   */
  get testUserEmail() {
    return parseEnv(
      "MARGIN_TEST_USER_EMAIL",
      OptionalEmailSchema,
      envValue("MARGIN_TEST_USER_EMAIL"),
    );
  },
};
