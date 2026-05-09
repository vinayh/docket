import { describe, expect, test } from "bun:test";
import { handleRegisterDocPost } from "./picker-register.ts";

/**
 * Format-level paths for /api/picker/register-doc. The bearer-auth check
 * short-circuits before any DB lookup when the header is missing or the
 * token's prefix is wrong, and the JSON body is parsed before
 * `createProject` runs — so these cases never need a configured DB.
 */

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/picker/register-doc", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleRegisterDocPost", () => {
  test("401 when Authorization is missing", async () => {
    const res = await handleRegisterDocPost(jsonRequest({ docUrlOrId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 when bearer token has the wrong prefix", async () => {
    const res = await handleRegisterDocPost(
      jsonRequest({ docUrlOrId: "abc" }, { authorization: "Bearer not-a-docket-token" }),
    );
    expect(res.status).toBe(401);
  });

  // Note: we deliberately don't exercise the dkt_-prefixed-but-unknown
  // path here because it hits the DB and CI's `bun test` runs without
  // applying migrations. The auth middleware's prefix short-circuit is
  // already covered in middleware.test.ts; the route's auth-first
  // ordering is what these tests guard against regressions in.
});
