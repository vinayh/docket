import { describe, expect, test } from "bun:test";
import {
  authenticateBearer,
  badRequest,
  jsonOk,
  methodNotAllowed,
  unauthorized,
} from "./middleware.ts";

describe("authenticateBearer", () => {
  // These test the format-level short-circuits in `authenticateBearer` —
  // the DB hash lookup is only invoked when the header matches the Bearer
  // grammar AND the token starts with the `mgn_` prefix. None of the cases
  // below should reach the DB.

  test("returns null when Authorization header is absent", async () => {
    const req = new Request("http://localhost/", { method: "POST" });
    expect(await authenticateBearer(req)).toBeNull();
  });

  test("returns null when scheme is not Bearer", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(await authenticateBearer(req)).toBeNull();
  });

  test("returns null when token has the wrong prefix", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { authorization: "Bearer not-a-margin-token" },
    });
    expect(await authenticateBearer(req)).toBeNull();
  });

  test("returns null when bearer header is empty", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { authorization: "Bearer " },
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

  test("methodNotAllowed() advertises allowed methods", () => {
    const r = methodNotAllowed(["GET", "POST"]);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, POST");
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
