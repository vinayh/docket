import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedUser } from "../../test/db.ts";
import { runCli } from "../../test/cli.ts";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";

const ALLOW = { MARGIN_ALLOW_E2E_SEED: "1" };

beforeEach(cleanDb);

describe("e2e seed-project", () => {
  test("no env flag → refuses, exit 1", async () => {
    await seedUser({ email: "t@e.com" });
    const r = await runCli(["e2e", "seed-project", "1AbcDEF0123456789_abc_test_doc", "--user", "t@e.com"], {
      MARGIN_ALLOW_E2E_SEED: undefined,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("MARGIN_ALLOW_E2E_SEED");
    // No rows leaked even though we passed otherwise-valid args.
    const rows = await db.select().from(project);
    expect(rows.length).toBe(0);
  });

  test("missing positional → usage exit 2", async () => {
    const r = await runCli(["e2e", "seed-project"], ALLOW);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("no --user and no MARGIN_TEST_USER_EMAIL → fatal", async () => {
    const r = await runCli(["e2e", "seed-project", "1AbcDEF0123456789_abc_test_doc"], {
      ...ALLOW,
      MARGIN_TEST_USER_EMAIL: undefined,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no user");
  });

  test("happy path: creates project + v1 row for the named owner", async () => {
    const u = await seedUser({ email: "owner@e.com" });
    const r = await runCli(
      ["e2e", "seed-project", "1AbcDEF0123456789_xyz_test_doc", "--user", "owner@e.com"],
      ALLOW,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("created project");
    const projects = await db
      .select()
      .from(project)
      .where(eq(project.parentDocId, "1AbcDEF0123456789_xyz_test_doc"));
    expect(projects.length).toBe(1);
    expect(projects[0]!.ownerUserId).toBe(u.id);

    const versions = await db
      .select()
      .from(version)
      .where(eq(version.projectId, projects[0]!.id));
    expect(versions.length).toBe(1);
    expect(versions[0]!.label).toBe("v1");
    expect(versions[0]!.googleDocId).toBe("1AbcDEF0123456789_xyz_test_doc");
  });

  test("re-run is idempotent — same owner, no duplicate rows", async () => {
    const u = await seedUser({ email: "owner@e.com" });
    await runCli(["e2e", "seed-project", "1AbcDEF0123456789_xyz_test_doc", "--user", u.email], ALLOW);
    const r = await runCli(
      ["e2e", "seed-project", "1AbcDEF0123456789_xyz_test_doc", "--user", u.email],
      ALLOW,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("reused project");

    const projects = await db
      .select()
      .from(project)
      .where(eq(project.parentDocId, "1AbcDEF0123456789_xyz_test_doc"));
    expect(projects.length).toBe(1);
    const versions = await db
      .select()
      .from(version)
      .where(eq(version.projectId, projects[0]!.id));
    expect(versions.length).toBe(1);
  });

  test("different owner → refuses with exit 1, doesn't clobber existing project", async () => {
    const a = await seedUser({ email: "a@e.com" });
    const b = await seedUser({ email: "b@e.com" });
    await runCli(["e2e", "seed-project", "1AbcDEF0123456789_xyz_test_doc", "--user", a.email], ALLOW);
    const r = await runCli(
      ["e2e", "seed-project", "1AbcDEF0123456789_xyz_test_doc", "--user", b.email],
      ALLOW,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("different owner");

    const projects = await db
      .select()
      .from(project)
      .where(eq(project.parentDocId, "1AbcDEF0123456789_xyz_test_doc"));
    expect(projects.length).toBe(1);
    expect(projects[0]!.ownerUserId).toBe(a.id);
  });

  test("accepts a full doc URL too", async () => {
    const u = await seedUser({ email: "owner@e.com" });
    const r = await runCli(
      [
        "e2e",
        "seed-project",
        "https://docs.google.com/document/d/SOME_DOC_ID_20charsXX/edit",
        "--user",
        u.email,
      ],
      ALLOW,
    );
    expect(r.exitCode).toBe(0);
    const projects = await db
      .select()
      .from(project)
      .where(eq(project.parentDocId, "SOME_DOC_ID_20charsXX"));
    expect(projects.length).toBe(1);
  });
});
