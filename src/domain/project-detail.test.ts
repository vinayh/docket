import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedCanonicalComment,
  seedDerivative,
  seedOverlay,
  seedProject,
  seedReviewRequest,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { getProjectDetail } from "./project-detail.ts";

beforeEach(cleanDb);

describe("getProjectDetail", () => {
  test("returns null when the project doesn't exist", async () => {
    const u = await seedUser();
    expect(await getProjectDetail({ projectId: "nope", userId: u.id })).toBeNull();
  });

  test("returns null for non-owner (no cross-tenant info leak)", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const other = await seedUser();
    expect(
      await getProjectDetail({ projectId: proj.id, userId: other.id }),
    ).toBeNull();
  });

  test("returns main (parent doc) first, then snapshots in createdAt desc order, with per-version stats", async () => {
    const u = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-parent" });
    const v1 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
      googleDocId: "doc-v1",
    });
    const syncTs = new Date("2025-04-01T00:00:00Z");
    const v2 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v2",
      googleDocId: "doc-v2",
      parentVersionId: v1.id,
      lastSyncedAt: syncTs,
    });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v1.id });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v1.id });

    const detail = await getProjectDetail({ projectId: proj.id, userId: u.id });
    expect(detail).not.toBeNull();
    expect(detail!.project.id).toBe(proj.id);
    expect(detail!.project.parentDocId).toBe("doc-parent");
    expect(detail!.project.ownerEmail).toBe("owner@example.com");

    // ensureMainVersion backfills a "main" row pointing at parent_doc_id;
    // listVersions floats it to the top. v1/v2 are seeded in the same ms so
    // their relative order is unstable — just assert membership.
    expect(detail!.versions[0]!.label).toBe("main");
    expect(detail!.versions[0]!.googleDocId).toBe("doc-parent");
    expect(detail!.versions.slice(1).map((v) => v.label).sort()).toEqual([
      "v1",
      "v2",
    ]);

    const v2d = detail!.versions.find((v) => v.id === v2.id)!;
    expect(v2d.status).toBe("active");
    expect(v2d.parentVersionId).toBe(v1.id);
    expect(v2d.commentCount).toBe(0);
    expect(v2d.lastSyncedAt).toBe(syncTs.getTime());

    const v1d = detail!.versions.find((v) => v.id === v1.id)!;
    expect(v1d.commentCount).toBe(2);
    expect(v1d.lastSyncedAt).toBeNull();
  });

  test("includes derivatives + open review requests, omits closed reviews", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: proj.id, createdByUserId: u.id });
    const ov = await seedOverlay({ projectId: proj.id });
    const d = await seedDerivative({
      projectId: proj.id,
      versionId: v.id,
      overlayId: ov.id,
      audienceLabel: "legal",
    });
    const open = await seedReviewRequest({
      projectId: proj.id,
      versionId: v.id,
      createdByUserId: u.id,
      status: "open",
    });
    await seedReviewRequest({
      projectId: proj.id,
      versionId: v.id,
      createdByUserId: u.id,
      status: "closed",
    });

    const detail = await getProjectDetail({ projectId: proj.id, userId: u.id });
    expect(detail!.derivatives).toHaveLength(1);
    expect(detail!.derivatives[0]!.id).toBe(d.id);
    expect(detail!.derivatives[0]!.audienceLabel).toBe("legal");

    expect(detail!.reviewRequests).toHaveLength(1);
    expect(detail!.reviewRequests[0]!.id).toBe(open.id);
    expect(detail!.reviewRequests[0]!.status).toBe("open");
  });

  test("project with no snapshots: main (parent doc) is backfilled, no derivatives or reviews", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-only-parent" });
    const detail = await getProjectDetail({ projectId: proj.id, userId: u.id });
    expect(detail!.versions.map((v) => v.label)).toEqual(["main"]);
    expect(detail!.versions[0]!.googleDocId).toBe("doc-only-parent");
    expect(detail!.derivatives).toEqual([]);
    expect(detail!.reviewRequests).toEqual([]);
  });
});
