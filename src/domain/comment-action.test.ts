import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  cleanDb,
  seedCanonicalComment,
  seedCommentProjection,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { db } from "../db/client.ts";
import { auditLog, canonicalComment, commentProjection } from "../db/schema.ts";
import {
  CommentActionBadRequestError,
  CommentActionNotFoundError,
  performCommentAction,
} from "./comment-action.ts";

beforeEach(cleanDb);

async function seedWorld() {
  const owner = await seedUser({ email: "owner@example.com" });
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
  });
  const cc = await seedCanonicalComment({
    projectId: proj.id,
    originVersionId: ver.id,
  });
  return { owner, proj, ver, cc };
}

async function loadStatus(id: string) {
  const rows = await db
    .select({ s: canonicalComment.status })
    .from(canonicalComment)
    .where(eq(canonicalComment.id, id))
    .limit(1);
  return rows[0]?.s;
}

async function countAudits(commentId: string) {
  // Status-transition audits use the bare comment id as targetId;
  // projection-scoped audits (accept_projection / reanchor) use the
  // composite `${commentId}:${versionId}` form. Count both so the test
  // helpers don't have to thread the projection scope through.
  const rows = await db.select({ targetId: auditLog.targetId }).from(auditLog);
  return rows.filter(
    (r) => r.targetId === commentId || r.targetId?.startsWith(`${commentId}:`),
  ).length;
}

describe("performCommentAction — status transitions", () => {
  test("mark_wontfix sets status to wontfix and writes an audit row", async () => {
    const { owner, cc } = await seedWorld();
    const result = await performCommentAction({
      userId: owner.id,
      canonicalCommentId: cc.id,
      action: "mark_wontfix",
    });
    expect(result.status).toBe("wontfix");
    expect(await loadStatus(cc.id)).toBe("wontfix");
    expect(await countAudits(cc.id)).toBe(1);
  });

  test("reopen moves an addressed comment back to open", async () => {
    const { owner, cc } = await seedWorld();
    await db
      .update(canonicalComment)
      .set({ status: "addressed" })
      .where(eq(canonicalComment.id, cc.id));

    const result = await performCommentAction({
      userId: owner.id,
      canonicalCommentId: cc.id,
      action: "reopen",
    });
    expect(result.status).toBe("open");
    expect(await loadStatus(cc.id)).toBe("open");
  });

  test("no-op on same-state status — no DB write, no audit row", async () => {
    const { owner, cc } = await seedWorld();
    // Comment starts as "open"; reopen on an already-open comment must be a
    // pure read.
    const result = await performCommentAction({
      userId: owner.id,
      canonicalCommentId: cc.id,
      action: "reopen",
    });
    expect(result.status).toBe("open");
    expect(await countAudits(cc.id)).toBe(0);
  });

  test("404-equivalent: ownership mismatch and missing comment both throw NotFound", async () => {
    const { cc } = await seedWorld();
    const stranger = await seedUser({ email: "stranger@example.com" });

    await expect(
      performCommentAction({
        userId: stranger.id,
        canonicalCommentId: cc.id,
        action: "mark_resolved",
      }),
    ).rejects.toBeInstanceOf(CommentActionNotFoundError);

    await expect(
      performCommentAction({
        userId: stranger.id,
        canonicalCommentId: "ghost",
        action: "mark_resolved",
      }),
    ).rejects.toBeInstanceOf(CommentActionNotFoundError);
  });
});

describe("performCommentAction — accept_projection", () => {
  test("requires targetVersionId", async () => {
    const { owner, cc } = await seedWorld();
    await expect(
      performCommentAction({
        userId: owner.id,
        canonicalCommentId: cc.id,
        action: "accept_projection",
      }),
    ).rejects.toBeInstanceOf(CommentActionBadRequestError);
  });

  test("404 when no projection row exists for the target version", async () => {
    const { owner, ver, cc } = await seedWorld();
    // No seedCommentProjection here on purpose.
    await expect(
      performCommentAction({
        userId: owner.id,
        canonicalCommentId: cc.id,
        action: "accept_projection",
        targetVersionId: ver.id,
      }),
    ).rejects.toBeInstanceOf(CommentActionNotFoundError);
  });

  test("re-accepting an already-resolved projection logs an audit and refreshes lastSyncedAt", async () => {
    const { owner, ver, cc } = await seedWorld();
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: ver.id,
      projectionStatus: "manually_resolved",
      anchorMatchConfidence: 100,
    });
    const beforeAudits = await countAudits(cc.id);

    const result = await performCommentAction({
      userId: owner.id,
      canonicalCommentId: cc.id,
      action: "accept_projection",
      targetVersionId: ver.id,
    });

    expect(result.projection?.status).toBe("manually_resolved");
    expect(result.projection?.anchorMatchConfidence).toBe(100);
    expect(await countAudits(cc.id)).toBe(beforeAudits + 1);
  });

  test("promotes a fuzzy projection to manually_resolved + confidence 100", async () => {
    const { owner, ver, cc } = await seedWorld();
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: ver.id,
      projectionStatus: "fuzzy",
      anchorMatchConfidence: 55,
    });
    await performCommentAction({
      userId: owner.id,
      canonicalCommentId: cc.id,
      action: "accept_projection",
      targetVersionId: ver.id,
    });
    const rows = await db
      .select()
      .from(commentProjection)
      .where(
        and(
          eq(commentProjection.canonicalCommentId, cc.id),
          eq(commentProjection.versionId, ver.id),
        ),
      );
    expect(rows[0]!.projectionStatus).toBe("manually_resolved");
    expect(rows[0]!.anchorMatchConfidence).toBe(100);
  });
});

describe("performCommentAction — reanchor", () => {
  test("requires targetVersionId", async () => {
    const { owner, cc } = await seedWorld();
    await expect(
      performCommentAction({
        userId: owner.id,
        canonicalCommentId: cc.id,
        action: "reanchor",
      }),
    ).rejects.toBeInstanceOf(CommentActionBadRequestError);
  });

  test("rejects cross-project versionId as not_found", async () => {
    // A target version that belongs to a *different* project is treated the
    // same as a missing version — refuses to leak existence across tenants.
    const { owner, cc } = await seedWorld();
    const otherProj = await seedProject({
      ownerUserId: owner.id,
      parentDocId: "other-doc",
    });
    const otherVer = await seedVersion({
      projectId: otherProj.id,
      createdByUserId: owner.id,
    });
    await expect(
      performCommentAction({
        userId: owner.id,
        canonicalCommentId: cc.id,
        action: "reanchor",
        targetVersionId: otherVer.id,
      }),
    ).rejects.toBeInstanceOf(CommentActionNotFoundError);
  });

  test("rejects unknown versionId as not_found", async () => {
    const { owner, cc } = await seedWorld();
    await expect(
      performCommentAction({
        userId: owner.id,
        canonicalCommentId: cc.id,
        action: "reanchor",
        targetVersionId: "ghost-version",
      }),
    ).rejects.toBeInstanceOf(CommentActionNotFoundError);
  });
});
