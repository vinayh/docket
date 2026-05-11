import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import {
  getVersion,
  listVersions,
  pickNextLabel,
  requireVersion,
} from "./version.ts";

describe("pickNextLabel", () => {
  test("empty project starts at v1", () => {
    expect(pickNextLabel([])).toBe("v1");
  });

  test("single existing v1 → v2", () => {
    expect(pickNextLabel(["v1"])).toBe("v2");
  });

  test("MAX-based: gaps in the sequence don't reuse old numbers", () => {
    // Pre-fix this used `existing.length + 1`, which would have returned `v3`
    // here (3 existing rows). Parsing MAX gives `v6`, which is what we want
    // even after archives or future deletes leave gaps.
    expect(pickNextLabel(["v1", "v3", "v5"])).toBe("v6");
  });

  test("manual labels are ignored", () => {
    expect(pickNextLabel(["alpha", "v1", "release-2024"])).toBe("v2");
  });

  test("only manual labels → v1", () => {
    expect(pickNextLabel(["alpha", "release"])).toBe("v1");
  });

  test("trailing zeros and large numbers are parsed correctly", () => {
    expect(pickNextLabel(["v009", "v42"])).toBe("v43");
  });

  test("does not match v-prefixed strings with non-digit suffixes", () => {
    expect(pickNextLabel(["v1.0", "v2-rc"])).toBe("v1");
  });
});

describe("getVersion / requireVersion / listVersions", () => {
  beforeEach(cleanDb);

  test("getVersion returns null for missing rows", async () => {
    expect(await getVersion(crypto.randomUUID())).toBeNull();
  });

  test("requireVersion throws with the missing id", async () => {
    const id = crypto.randomUUID();
    await expect(requireVersion(id)).rejects.toThrow(new RegExp(id));
  });

  test("listVersions orders newest-first", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v1 = await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v1" });
    // bun:sqlite stores createdAt as ms — wait one tick to avoid identical
    // timestamps on fast hardware.
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v2" });

    const ordered = await listVersions(p.id);
    expect(ordered.map((v) => v.id)).toEqual([v2.id, v1.id]);
  });

  test("listVersions returns [] for a project with no versions", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    expect(await listVersions(p.id)).toEqual([]);
  });

  test("listVersions is scoped to its project (no cross-project leak)", async () => {
    const u = await seedUser();
    const a = await seedProject({ ownerUserId: u.id });
    const b = await seedProject({ ownerUserId: u.id });
    const va = await seedVersion({ projectId: a.id, createdByUserId: u.id, label: "v1" });
    await seedVersion({ projectId: b.id, createdByUserId: u.id, label: "v1" });

    const inA = await listVersions(a.id);
    expect(inA.map((v) => v.id)).toEqual([va.id]);
  });

});
