import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import {
  DuplicateProjectError,
  getProject,
  listAllProjects,
  requireProject,
  tokenProviderForProject,
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

describe("listAllProjects", () => {
  test("empty DB → empty array", async () => {
    expect(await listAllProjects()).toEqual([]);
  });

  test("returns projects across owners", async () => {
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    await seedProject({ ownerUserId: alice.id });
    await seedProject({ ownerUserId: bob.id });
    await seedProject({ ownerUserId: bob.id });
    expect(await listAllProjects()).toHaveLength(3);
  });
});

describe("tokenProviderForProject", () => {
  test("throws when the project doesn't exist", async () => {
    const id = crypto.randomUUID();
    await expect(tokenProviderForProject(id)).rejects.toThrow(new RegExp(id));
  });

  test("returns a TokenProvider scoped to the project's owner without hitting Drive", async () => {
    // We never call `getAccessToken` here — the contract is just "build a
    // TokenProvider for the owner." Refresh-on-401 + `loadRefreshToken`
    // belong to `tokenProviderForUser`'s own tests.
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const tp = await tokenProviderForProject(p.id);
    expect(typeof tp.getAccessToken).toBe("function");
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
