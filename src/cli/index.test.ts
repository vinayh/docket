import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { runCli } from "../../test/cli.ts";

beforeEach(cleanDb);

describe("dispatcher", () => {
  test("no arguments → exit 0 with usage banner on stderr", async () => {
    const r = await runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("usage:");
  });

  test("unknown subcommand → exit 2", async () => {
    const r = await runCli(["nope"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("--help and -h reach the same banner with exit 0", async () => {
    const a = await runCli(["--help"]);
    const b = await runCli(["-h"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stderr).toContain("usage:");
    expect(b.stderr).toContain("usage:");
  });

  test("a runtime failure inside a handler exits 1 with `error:` prefix", async () => {
    // `inspect <url>` with no users in the DB throws via requireFirstUser →
    // the index.ts try/catch maps it to exit 1.
    const r = await runCli(["inspect", "https://docs.google.com/document/d/missing/edit"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("error:");
  });
});

describe("project list", () => {
  test("empty DB prints `no projects.`", async () => {
    const r = await runCli(["project", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no projects.");
  });

  test("seeded projects appear with parent doc id", async () => {
    const u = await seedUser({ email: "vh@example.com" });
    await seedProject({ ownerUserId: u.id, parentDocId: "doc-known" });
    const r = await runCli(["project", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("doc-known");
    expect(r.stdout).toContain(u.id);
  });

  test("project (no subcommand) shows usage with exit 2", async () => {
    const r = await runCli(["project"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});

describe("version list", () => {
  test("requires a project-id argument", async () => {
    const r = await runCli(["version", "list"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("lists versions for a project, newest first", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v1 = await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v1" });
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v2" });

    const r = await runCli(["version", "list", p.id]);
    expect(r.exitCode).toBe(0);
    // newest first → v2 appears earlier in stdout than v1
    expect(r.stdout.indexOf(v2.id)).toBeGreaterThan(-1);
    expect(r.stdout.indexOf(v1.id)).toBeGreaterThan(r.stdout.indexOf(v2.id));
  });
});

