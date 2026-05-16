import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedCanonicalComment,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import {
  countCommentsByOriginVersion,
  countComments,
  countOpenReviews,
  pickLastSyncedAtByVersion,
  pickLastSyncedAt,
} from "./stats.ts";
import { seedReviewRequest } from "../../test/db.ts";

beforeEach(cleanDb);

describe("countCommentsByOriginVersion", () => {
  test("groups by origin_version_id, ignores other projects", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v1 = await seedVersion({ projectId: proj.id, createdByUserId: u.id, label: "v1" });
    const v2 = await seedVersion({ projectId: proj.id, createdByUserId: u.id, label: "v2" });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v1.id });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v1.id });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v2.id });

    // Another project's comments must not leak in.
    const proj2 = await seedProject({ ownerUserId: u.id });
    const v2_1 = await seedVersion({ projectId: proj2.id, createdByUserId: u.id });
    await seedCanonicalComment({ projectId: proj2.id, originVersionId: v2_1.id });

    const counts = await countCommentsByOriginVersion(proj.id);
    expect(counts.get(v1.id)).toBe(2);
    expect(counts.get(v2.id)).toBe(1);
    expect(counts.has(v2_1.id)).toBe(false);
  });
});

describe("pickLastSyncedAtByVersion", () => {
  test("returns version.lastSyncedAt per version, null when absent", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const recent = new Date("2025-06-01T00:00:00Z");
    const old = new Date("2025-01-01T00:00:00Z");
    const v1 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      lastSyncedAt: recent,
    });
    const v2 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      lastSyncedAt: old,
    });
    // v3: never synced → null
    const v3 = await seedVersion({ projectId: proj.id, createdByUserId: u.id });

    const map = await pickLastSyncedAtByVersion([v1.id, v2.id, v3.id]);
    expect(map.get(v1.id)).toBe(recent.getTime());
    expect(map.get(v2.id)).toBe(old.getTime());
    expect(map.get(v3.id)).toBe(null);
  });

  test("empty input → empty map", async () => {
    const map = await pickLastSyncedAtByVersion([]);
    expect(map.size).toBe(0);
  });
});

describe("non-batched helpers (kept for doc-state)", () => {
  test("pickLastSyncedAt returns version.lastSyncedAt", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const ts = new Date("2025-03-01T00:00:00Z");
    const v = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      lastSyncedAt: ts,
    });
    expect(await pickLastSyncedAt(v.id)).toBe(ts.getTime());
  });

  test("countComments + countOpenReviews are scoped to the project", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: proj.id, createdByUserId: u.id });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v.id });
    await seedCanonicalComment({ projectId: proj.id, originVersionId: v.id });
    await seedReviewRequest({
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
    expect(await countComments(proj.id)).toBe(2);
    expect(await countOpenReviews(proj.id)).toBe(1);
  });
});
