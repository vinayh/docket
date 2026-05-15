import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import {
  account,
  auditLog,
  reviewAssignment,
  reviewRequest,
  reviewActionToken,
  user,
} from "../db/schema.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { eq } from "drizzle-orm";
import {
  createReviewRequest,
  listAssigneesForRequests,
  ReviewRequestBadRequestError,
  ReviewRequestNotFoundError,
} from "./review.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

function stubGoogle(opts: { permissionStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  setFetch(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/drive.file",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/drive/v3/files/") && url.includes("/permissions")) {
      const status = opts.permissionStatus ?? 200;
      if (status >= 400) {
        return new Response("nope", { status });
      }
      return new Response(
        JSON.stringify({
          id: "perm-1",
          type: "user",
          role: "commenter",
          emailAddress: "alice@example.com",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });
  return calls;
}

describe("createReviewRequest", () => {
  beforeEach(cleanDb);

  test("rejects when version not owned by caller", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
    });
    const stranger = await seedUser({ email: "stranger@example.com" });

    await expect(
      createReviewRequest({
        versionId: ver.id,
        ownerUserId: stranger.id,
        assigneeEmails: ["bob@example.com"],
      }),
    ).rejects.toBeInstanceOf(ReviewRequestNotFoundError);
  });

  test("rejects when assignee list is empty after dedupe/trim", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
    });

    await expect(
      createReviewRequest({
        versionId: ver.id,
        ownerUserId: owner.id,
        assigneeEmails: ["   ", "\t"],
      }),
    ).rejects.toBeInstanceOf(ReviewRequestBadRequestError);
  });

  test("creates request, assignments, magic-link tokens, audit log; shares doc", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    await seedDriveCredential(owner.id);
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
      googleDocId: "doc-v1",
    });

    const calls = stubGoogle();
    const result = await createReviewRequest({
      versionId: ver.id,
      ownerUserId: owner.id,
      assigneeEmails: ["Alice@Example.com", "alice@example.com", "bob@example.com"],
    });

    expect(result.assignees).toHaveLength(2);
    expect(result.assignees.map((a) => a.email).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    // Default action set: mark_reviewed, request_changes, decline.
    for (const a of result.assignees) {
      expect(a.shareError).toBeNull();
      expect(a.emailError).toBeNull();
      expect(a.links.map((l) => l.action).sort()).toEqual([
        "decline",
        "mark_reviewed",
        "request_changes",
      ]);
      // All three links share a single token (one row per assignee) and vary
      // only in the ?action= query string.
      const tokens = new Set(
        a.links.map((l) => l.url.replace(/\?action=.*/, "")),
      );
      expect(tokens.size).toBe(1);
      for (const l of a.links) {
        expect(l.url).toMatch(/\/r\/mra_.+\?action=/);
        expect(l.url).toContain(`?action=${l.action}`);
        expect(l.expiresAt).toBeGreaterThan(Date.now());
      }
    }

    const reqs = await db
      .select()
      .from(reviewRequest)
      .where(eq(reviewRequest.id, result.reviewRequestId));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.versionId).toBe(ver.id);
    expect(reqs[0]!.status).toBe("open");

    const assignmentRows = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.reviewRequestId, result.reviewRequestId));
    expect(assignmentRows).toHaveLength(2);
    expect(assignmentRows.every((a) => a.status === "pending")).toBe(true);

    const tokenRows = await db
      .select()
      .from(reviewActionToken)
      .where(eq(reviewActionToken.reviewRequestId, result.reviewRequestId));
    // One token per assignee; action passed at redeem time via ?action=.
    expect(tokenRows).toHaveLength(2);

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, result.reviewRequestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("review_request.create");

    // External reviewer (bob) had no prior user row; one was created.
    const bob = await db.select().from(user).where(eq(user.email, "bob@example.com"));
    expect(bob).toHaveLength(1);

    // permissions.create called once per unique email.
    const permissionCalls = calls.filter(
      (c) => c.url.includes("/permissions") && c.method === "POST",
    );
    expect(permissionCalls).toHaveLength(2);
    expect(
      permissionCalls.every((c) =>
        c.url.includes(`/files/${encodeURIComponent("doc-v1")}/permissions`),
      ),
    ).toBe(true);
    expect(
      permissionCalls.every(
        (c) => c.url.includes("sendNotificationEmail=false"),
      ),
    ).toBe(true);
  });

  test("still issues magic-link tokens when Drive share fails", async () => {
    const owner = await seedUser({ email: "owner2@example.com" });
    await seedDriveCredential(owner.id);
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
      googleDocId: "doc-v1",
    });

    stubGoogle({ permissionStatus: 500 });
    const result = await createReviewRequest({
      versionId: ver.id,
      ownerUserId: owner.id,
      assigneeEmails: ["alice@example.com"],
    });
    expect(result.assignees[0]!.links).toHaveLength(3);
    expect(result.assignees[0]!.shareError).not.toBeNull();
    expect(result.assignees[0]!.shareError).toContain("500");

    const tokenRows = await db
      .select()
      .from(reviewActionToken)
      .where(eq(reviewActionToken.reviewRequestId, result.reviewRequestId));
    expect(tokenRows).toHaveLength(1);
  });

  test("invokes email transport once per assignee with magic links", async () => {
    const owner = await seedUser({ email: "owner3@example.com" });
    await seedDriveCredential(owner.id);
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
      googleDocId: "doc-v1",
    });

    stubGoogle();
    const sent: { to: string; subject: string; text: string }[] = [];
    const result = await createReviewRequest({
      versionId: ver.id,
      ownerUserId: owner.id,
      assigneeEmails: ["alice@example.com", "bob@example.com"],
      emailTransport: {
        async send(msg) {
          sent.push(msg);
        },
      },
    });

    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    for (const m of sent) {
      expect(m.subject).toContain("owner3@example.com");
      expect(m.text).toContain("/r/mra_");
      expect(m.text).toContain("docs.google.com/document/d/doc-v1");
    }
    for (const a of result.assignees) expect(a.emailError).toBeNull();
  });

  test("records emailError when transport throws; magic links still issued", async () => {
    const owner = await seedUser({ email: "owner4@example.com" });
    await seedDriveCredential(owner.id);
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
      googleDocId: "doc-v1",
    });

    stubGoogle();
    const result = await createReviewRequest({
      versionId: ver.id,
      ownerUserId: owner.id,
      assigneeEmails: ["alice@example.com"],
      emailTransport: {
        async send() {
          throw new Error("smtp 421");
        },
      },
    });

    expect(result.assignees[0]!.emailError).toBe("smtp 421");
    expect(result.assignees[0]!.links).toHaveLength(3);
    // One DB row backs the three per-action URLs.
    const tokenRows = await db
      .select()
      .from(reviewActionToken)
      .where(eq(reviewActionToken.reviewRequestId, result.reviewRequestId));
    expect(tokenRows).toHaveLength(1);
    expect(result.assignees[0]!.shareError).toBeNull();
  });
});

describe("listAssigneesForRequests", () => {
  beforeEach(cleanDb);

  test("returns email + status keyed by request id", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
    });

    stubGoogle();
    const result = await createReviewRequest({
      versionId: ver.id,
      ownerUserId: owner.id,
      assigneeEmails: ["alice@example.com"],
    });
    const map = await listAssigneesForRequests([result.reviewRequestId]);
    const list = map.get(result.reviewRequestId);
    expect(list).toHaveLength(1);
    expect(list![0]!.email).toBe("alice@example.com");
    expect(list![0]!.status).toBe("pending");
  });

  test("empty input returns empty map (no SQL `IN ()`)", async () => {
    const map = await listAssigneesForRequests([]);
    expect(map.size).toBe(0);
  });
});
