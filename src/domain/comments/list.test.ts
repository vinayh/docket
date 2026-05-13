import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  cleanDb,
  seedCanonicalComment,
  seedProject,
  seedUser,
  seedVersion,
} from "../../../test/db.ts";
import { db } from "../../db/client.ts";
import { canonicalComment } from "../../db/schema.ts";
import { listCommentsForProject } from "./list.ts";

beforeEach(cleanDb);

describe("listCommentsForProject", () => {
  test("empty project → []", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    expect(await listCommentsForProject(p.id)).toEqual([]);
  });

  test("orders newest-first by originTimestamp", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const older = await seedCanonicalComment({
      projectId: p.id,
      originVersionId: v.id,
      body: "older",
    });
    const newer = await seedCanonicalComment({
      projectId: p.id,
      originVersionId: v.id,
      body: "newer",
    });
    // seedCanonicalComment writes `new Date()` and tests on fast hardware can
    // collide on millis; pin the timestamps explicitly so the ordering assertion
    // is deterministic.
    await db
      .update(canonicalComment)
      .set({ originTimestamp: new Date("2026-01-01T00:00:00Z") })
      .where(eq(canonicalComment.id, older.id));
    await db
      .update(canonicalComment)
      .set({ originTimestamp: new Date("2026-02-01T00:00:00Z") })
      .where(eq(canonicalComment.id, newer.id));

    const got = await listCommentsForProject(p.id);
    expect(got.map((c) => c.body)).toEqual(["newer", "older"]);
  });

  test("excludes comments from other projects (no cross-project leak)", async () => {
    const u = await seedUser();
    const a = await seedProject({ ownerUserId: u.id });
    const b = await seedProject({ ownerUserId: u.id });
    const va = await seedVersion({ projectId: a.id, createdByUserId: u.id });
    const vb = await seedVersion({ projectId: b.id, createdByUserId: u.id });
    const inA = await seedCanonicalComment({
      projectId: a.id,
      originVersionId: va.id,
      body: "a",
    });
    await seedCanonicalComment({
      projectId: b.id,
      originVersionId: vb.id,
      body: "b",
    });
    const got = await listCommentsForProject(a.id);
    expect(got.map((c) => c.id)).toEqual([inA.id]);
  });
});
