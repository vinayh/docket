import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  authenticateBearer,
  badRequest,
  IdSchema,
  jsonOk,
  MAX_ID_LEN,
  unauthorized,
} from "./middleware.ts";

describe("authenticateBearer", () => {
  // The middleware is now a thin wrapper around Better Auth's
  // `auth.api.getSession`; it returns null whenever the session lookup
  // doesn't resolve a user. Exhaustive header parsing lives inside Better
  // Auth's bearer plugin and isn't re-tested here.

  test("returns null when Authorization header is absent", async () => {
    const req = new Request("http://localhost/", { method: "POST" });
    expect(await authenticateBearer(req)).toBeNull();
  });

  test("returns null when bearer token is unknown", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-session" },
    });
    expect(await authenticateBearer(req)).toBeNull();
  });
});

describe("response helpers", () => {
  test("unauthorized() carries a WWW-Authenticate challenge", () => {
    const r = unauthorized();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("badRequest() emits json with a message", async () => {
    const r = badRequest("nope");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_request", message: "nope" });
  });

  test("jsonOk() defaults to 200", async () => {
    const r = jsonOk({ x: 1 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ x: 1 });
  });
});

/**
 * AGENTS.md endorses the hand-mirrored copy in
 * `surfaces/extension/utils/messages.ts` (the extension bundle can't import
 * backend code). This guard pins the two values so a drift on either side
 * is the failing case here, not a silent SW-vs-API discrepancy.
 */
describe("id-length parity (backend ↔ extension)", () => {
  test("MAX_ID_LEN matches the extension's mirror", async () => {
    // String import keeps this file out of the extension's bundle graph.
    const text = await Bun.file(
      new URL("../../surfaces/extension/utils/messages.ts", import.meta.url),
    ).text();
    const match = /const\s+MAX_ID_LEN\s*=\s*(\d+)\s*;/.exec(text);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(MAX_ID_LEN);
  });

  test("IdSchema rejects strings at MAX_ID_LEN + 1", () => {
    const tooLong = "a".repeat(MAX_ID_LEN + 1);
    expect(v.safeParse(IdSchema, tooLong).success).toBe(false);
    expect(v.safeParse(IdSchema, "a".repeat(MAX_ID_LEN)).success).toBe(true);
  });
});
