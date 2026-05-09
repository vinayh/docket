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

  test("401 even when token has dkt_ prefix but isn't in the DB", async () => {
    // With a recognized prefix the verifier hits the DB, finds nothing,
    // and returns null — the route still 401s (auth gates everything,
    // including the body parser).
    const req = new Request("http://localhost/api/picker/register-doc", {
      method: "POST",
      headers: {
        authorization: "Bearer dkt_unknown_token_value_for_test",
        "content-type": "application/json",
      },
      body: "not json",
    });
    const res = await handleRegisterDocPost(req);
    expect(res.status).toBe(401);
  });
});
