import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { account, project } from "../db/schema.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import type { DriveFile } from "../google/drive.ts";
import {
  createProject,
  DuplicateProjectError,
  getProject,
  listAllProjects,
  requireProject,
  tokenProviderForProject,
} from "./project.ts";

beforeEach(cleanDb);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

function stubDriveGetFile(byId: Record<string, Partial<DriveFile>>): {
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  setFetch(async (input) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = /\/drive\/v3\/files\/([^/?]+)\?/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const f = byId[id];
      if (!f) return new Response("not found", { status: 404 });
      const file: DriveFile = {
        id,
        name: f.name ?? "Untitled",
        mimeType: f.mimeType ?? GOOGLE_DOC_MIME,
        trashed: f.trashed ?? false,
        ...f,
      };
      return new Response(JSON.stringify(file), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { calls };
}

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

describe("createProject", () => {
  test("happy path: inserts a project row and returns it", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    stubDriveGetFile({
      "1aB-cD_0123456789zZyXwVu": {
        name: "My Doc",
        mimeType: GOOGLE_DOC_MIME,
      },
    });

    const proj = await createProject({
      ownerUserId: u.id,
      parentDocUrlOrId:
        "https://docs.google.com/document/d/1aB-cD_0123456789zZyXwVu/edit",
    });
    expect(proj.ownerUserId).toBe(u.id);
    expect(proj.parentDocId).toBe("1aB-cD_0123456789zZyXwVu");
    expect(proj.settings).toEqual({});

    const rows = await db
      .select()
      .from(project)
      .where(eq(project.id, proj.id));
    expect(rows).toHaveLength(1);
  });

  test("pre-check short-circuits before any Drive call when the project already exists for this owner", async () => {
    const u = await seedUser();
    const existing = await seedProject({
      ownerUserId: u.id,
      parentDocId: "docalreadyhere_0123456789",
    });
    // Track fetches so we can assert Drive wasn't called.
    const { calls } = stubDriveGetFile({});

    let err: unknown;
    try {
      await createProject({
        ownerUserId: u.id,
        parentDocUrlOrId: "docalreadyhere_0123456789",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateProjectError);
    expect((err as DuplicateProjectError).projectId).toBe(existing.id);
    expect((err as DuplicateProjectError).parentDocId).toBe("docalreadyhere_0123456789");
    // No Drive call — the pre-check returned before reaching getFile.
    expect(calls.every((c) => !c.url.includes("drive/v3"))).toBe(true);
  });

  test("rejects when the file is not a Google Doc", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    stubDriveGetFile({
      "non-doc-id-0123456789zZ": {
        name: "Spreadsheet",
        mimeType: "application/vnd.google-apps.spreadsheet",
      },
    });

    await expect(
      createProject({
        ownerUserId: u.id,
        parentDocUrlOrId: "non-doc-id-0123456789zZ",
      }),
    ).rejects.toThrow(/expected a Google Doc/);
  });

  test("rejects when the file is in the trash", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    stubDriveGetFile({
      "trashed-doc-0123456789zZyX": {
        name: "Gone",
        mimeType: GOOGLE_DOC_MIME,
        trashed: true,
      },
    });

    await expect(
      createProject({
        ownerUserId: u.id,
        parentDocUrlOrId: "trashed-doc-0123456789zZyX",
      }),
    ).rejects.toThrow(/in the trash/);
  });

  test("cross-owner: same parentDocId is allowed for two different owners", async () => {
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    await seedDriveCredential(alice.id);
    await seedDriveCredential(bob.id);
    stubDriveGetFile({
      "shared-doc-id-0123456789zZ": {
        name: "Shared",
        mimeType: GOOGLE_DOC_MIME,
      },
    });

    const a = await createProject({
      ownerUserId: alice.id,
      parentDocUrlOrId: "shared-doc-id-0123456789zZ",
    });
    const b = await createProject({
      ownerUserId: bob.id,
      parentDocUrlOrId: "shared-doc-id-0123456789zZ",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.parentDocId).toBe(b.parentDocId);
  });

  test("race: pre-check passes but a concurrent insert wins → DuplicateProjectError from the unique-index catch", async () => {
    // The pre-check returns null because we haven't seeded the row yet. The
    // Drive stub then runs and we seed the project to simulate a concurrent
    // ingest that committed between the SELECT and the INSERT. The INSERT
    // throws on the unique index and the catch branch loads the winner.
    const u = await seedUser();
    await seedDriveCredential(u.id);
    let pendingSeed = true;
    setFetch(async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-test",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/drive/v3/files/")) {
        // Seed the duplicate row mid-flight, after the pre-check has run but
        // before the INSERT. The next DB write will hit the unique index.
        if (pendingSeed) {
          await seedProject({
            ownerUserId: u.id,
            parentDocId: "race-doc-1aB-cD_0123456789",
          });
          pendingSeed = false;
        }
        return new Response(
          JSON.stringify({
            id: "race-doc-1aB-cD_0123456789",
            name: "Doc",
            mimeType: GOOGLE_DOC_MIME,
            trashed: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(
      createProject({
        ownerUserId: u.id,
        parentDocUrlOrId: "race-doc-1aB-cD_0123456789",
      }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);
  });
});
