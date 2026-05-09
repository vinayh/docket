import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import {
  DuplicateProjectError,
  getProject,
  listAllProjects,
  listProjectsForOwner,
  requireProject,
} from "./project.ts";

beforeEach(cleanDb);

describe("getProject / requireProject", () => {
  test("getProject returns null when missing", async () => {
    expect(await getProject(crypto.randomUUID())).toBeNull();
  });

  test("requireProject throws with the missing id", async () => {
    const id = crypto.randomUUID();
    await expect(requireProject(id)).rejects.toThrow(new RegExp(id));
  });

  test("round-trips an inserted project", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    expect((await getProject(p.id))?.id).toBe(p.id);
    expect((await requireProject(p.id)).id).toBe(p.id);
  });
});

describe("listProjectsForOwner / listAllProjects", () => {
  test("empty DB → empty arrays", async () => {
    expect(await listAllProjects()).toEqual([]);
    expect(await listProjectsForOwner(crypto.randomUUID())).toEqual([]);
  });

  test("listProjectsForOwner filters by owner; listAllProjects returns both", async () => {
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    const aProj = await seedProject({ ownerUserId: alice.id });
    const bProj1 = await seedProject({ ownerUserId: bob.id });
    const bProj2 = await seedProject({ ownerUserId: bob.id });

    const aliceProjects = await listProjectsForOwner(alice.id);
    expect(aliceProjects.map((p) => p.id)).toEqual([aProj.id]);

    const bobProjects = await listProjectsForOwner(bob.id);
    expect(bobProjects.map((p) => p.id).sort()).toEqual([bProj1.id, bProj2.id].sort());

    const all = await listAllProjects();
    expect(all).toHaveLength(3);
  });
});

describe("DuplicateProjectError", () => {
  test("carries projectId and parentDocId", () => {
    const e = new DuplicateProjectError("proj-1", "doc-1");
    expect(e.projectId).toBe("proj-1");
    expect(e.parentDocId).toBe("doc-1");
    expect(e.name).toBe("DuplicateProjectError");
    expect(e.message).toContain("doc-1");
    expect(e.message).toContain("proj-1");
  });
});
