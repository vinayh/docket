import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { issueApiToken } from "../auth/api-token.ts";
import { handleCapturesPost } from "./extension.ts";

beforeEach(cleanDb);

function postCaptures(body: unknown, opts?: { auth?: string; contentLength?: string }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  if (opts?.contentLength) headers.set("content-length", opts.contentLength);
  return new Request("http://localhost/api/extension/captures", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("validation paths", () => {
  test("401 without bearer", async () => {
    const res = await handleCapturesPost(postCaptures({ captures: [] }));
    expect(res.status).toBe(401);
  });

  test("400 when content-length exceeds the cap", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleCapturesPost(
      postCaptures(
        { captures: [] },
        { auth: `Bearer ${token}`, contentLength: String(1024 * 1024) },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("too large");
  });

  test("400 on invalid JSON", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleCapturesPost(
      postCaptures("not-json", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("invalid json");
  });

  test("400 when captures is missing or wrong shape", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });

    expect(
      (await handleCapturesPost(postCaptures({}, { auth: `Bearer ${token}` }))).status,
    ).toBe(400);
    expect(
      (
        await handleCapturesPost(
          postCaptures({ captures: "nope" }, { auth: `Bearer ${token}` }),
        )
      ).status,
    ).toBe(400);
    // missing required fields on a capture
    expect(
      (
        await handleCapturesPost(
          postCaptures(
            { captures: [{ externalId: "e1" }] },
            { auth: `Bearer ${token}` },
          ),
        )
      ).status,
    ).toBe(400);
  });

  test("200 with empty results for an empty captures array", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleCapturesPost(
      postCaptures({ captures: [] }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  test("400 on a batch larger than the cap", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const captures = Array.from({ length: 51 }, (_, i) => ({
      externalId: `e${i}`,
      docId: "doc-x",
      body: "hi",
    }));
    const res = await handleCapturesPost(
      postCaptures({ captures }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("batch too large");
  });
});

describe("authenticated success paths", () => {
  test("known docId routes to ingest and returns a status per capture", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-known" });
    await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-known",
    });
    const { token } = await issueApiToken({ userId: u.id });

    const res = await handleCapturesPost(
      postCaptures(
        {
          captures: [
            { externalId: "ext-1", docId: "doc-known", body: "first reply" },
          ],
        },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { externalId: string; status: string }[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.externalId).toBe("ext-1");
    // No parent suggestion in the DB → orphaned; what we want to confirm is
    // that the route reached `ingestExtensionCaptures` (not 401/400).
    expect(["inserted", "orphaned", "version_unknown"]).toContain(
      body.results[0]!.status,
    );
  });

  test("unknown docId returns version_unknown — not 401/400", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });

    const res = await handleCapturesPost(
      postCaptures(
        {
          captures: [{ externalId: "ext-z", docId: "doc-nobody-owns", body: "hi" }],
        },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: string }[] };
    expect(body.results[0]!.status).toBe("version_unknown");
  });
});
