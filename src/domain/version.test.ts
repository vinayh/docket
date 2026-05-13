import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { account, version } from "../db/schema.ts";
import type { Document } from "../google/docs.ts";
import { paragraphHash } from "./anchor.ts";
import {
  createVersion,
  getVersion,
  listVersions,
  pickNextLabel,
  requireVersion,
} from "./version.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

function singleParaDoc(id: string, text: string): Document {
  const content = text + "\n";
  return {
    documentId: id,
    title: id,
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 1 + content.length,
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 1 + content.length, textRun: { content } },
            ],
          },
        },
      ],
    },
  };
}

interface CallLog {
  copyCalls: { fileId: string; body: unknown }[];
  getFileCalls: { fileId: string; fields: string | null }[];
  getDocCalls: { documentId: string }[];
}

function stubDriveAndDocs(opts: {
  /** Maps parentDocId → file name returned by getFile. */
  parents: Record<string, string>;
  /** Maps copyId → Document returned by getDocument for that copy. */
  copies: Record<string, Document>;
  /** copyFile returns this id. */
  newCopyId: string;
}): CallLog {
  const log: CallLog = { copyCalls: [], getFileCalls: [], getDocCalls: [] };
  setFetch(async (input, init) => {
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
    // copy: POST /drive/v3/files/<id>/copy
    const copyM = /\/drive\/v3\/files\/([^/]+)\/copy\?/.exec(url);
    if (copyM && init?.method === "POST") {
      const fileId = decodeURIComponent(copyM[1]!);
      const body = init.body ? JSON.parse(String(init.body)) : null;
      log.copyCalls.push({ fileId, body });
      return new Response(
        JSON.stringify({
          id: opts.newCopyId,
          name: (body as { name?: string })?.name ?? "Untitled",
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // get file: GET /drive/v3/files/<id>?…
    const getM = /\/drive\/v3\/files\/([^/?]+)\?(.+)/.exec(url);
    if (getM && (!init?.method || init.method === "GET")) {
      const fileId = decodeURIComponent(getM[1]!);
      const fields = new URLSearchParams(getM[2]!).get("fields");
      log.getFileCalls.push({ fileId, fields });
      const name = opts.parents[fileId];
      if (!name) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          id: fileId,
          name,
          mimeType: "application/vnd.google-apps.document",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // files.watch: POST /drive/v3/files/<id>/watch — invoked by the
    // best-effort autoSubscribeWatch background task. Return a canned
    // channel response so the warning doesn't pollute test output.
    const watchM = /\/drive\/v3\/files\/([^/]+)\/watch/.exec(url);
    if (watchM && init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          kind: "api#channel",
          id: (body as { id?: string })?.id ?? crypto.randomUUID(),
          resourceId: `resource-${crypto.randomUUID()}`,
          resourceUri: `https://example.com/${decodeURIComponent(watchM[1]!)}`,
          token: (body as { token?: string })?.token,
          expiration: String(Date.now() + 86_400_000),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // documents.get: GET /v1/documents/<id>
    const docM = /docs\.googleapis\.com\/v1\/documents\/([^/?]+)/.exec(url);
    if (docM) {
      const documentId = decodeURIComponent(docM[1]!);
      log.getDocCalls.push({ documentId });
      const doc = opts.copies[documentId];
      if (!doc) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return log;
}

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

describe("createVersion", () => {
  beforeEach(cleanDb);

  test("happy path: copies the parent doc, fetches it, stamps snapshotContentHash, inserts row", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-id-0123456789" });
    const log = stubDriveAndDocs({
      parents: { "parent-doc-id-0123456789": "Original" },
      newCopyId: "copy-id-aaaaaaaaaaaaaaaaaa",
      copies: { "copy-id-aaaaaaaaaaaaaaaaaa": singleParaDoc("copy-id-aaaaaaaaaaaaaaaaaa", "hello world") },
    });

    const ver = await createVersion({
      projectId: p.id,
      createdByUserId: u.id,
    });
    expect(ver.projectId).toBe(p.id);
    expect(ver.googleDocId).toBe("copy-id-aaaaaaaaaaaaaaaaaa");
    expect(ver.label).toBe("v1");
    expect(ver.parentVersionId).toBeNull();
    expect(ver.status).toBe("active");
    // snapshotContentHash is paragraphHash of the extracted plaintext —
    // singleParaDoc serializes one text run with a trailing newline, and
    // extractPlainText keeps the newline.
    expect(ver.snapshotContentHash).toBe(paragraphHash("hello world\n"));

    // Drive interaction shape.
    expect(log.getFileCalls).toHaveLength(1);
    expect(log.getFileCalls[0]?.fileId).toBe("parent-doc-id-0123456789");
    expect(log.getFileCalls[0]?.fields).toBe("id,name");
    expect(log.copyCalls).toHaveLength(1);
    expect((log.copyCalls[0]?.body as { name?: string }).name).toBe("[Margin v1] Original");
    expect(log.getDocCalls).toEqual([{ documentId: "copy-id-aaaaaaaaaaaaaaaaaa" }]);
  });

  test("auto-labels MAX+1 — three existing v* labels produce v4", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-bbbbbbbbbb-0123" });
    await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v1" });
    await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v3" });
    await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v5" });
    stubDriveAndDocs({
      parents: { "parent-doc-bbbbbbbbbb-0123": "P" },
      newCopyId: "copy-id-bbbbbbbbbbbbbbbbbb",
      copies: { "copy-id-bbbbbbbbbbbbbbbbbb": singleParaDoc("c", "x") },
    });

    const ver = await createVersion({
      projectId: p.id,
      createdByUserId: u.id,
      // No label, no parentVersionId — exercise both auto branches.
    });
    expect(ver.label).toBe("v6");
  });

  test("auto-links parentVersionId to the most recent version when undefined", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-cccccccccc-0123" });
    const prev = await seedVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "v1",
    });
    stubDriveAndDocs({
      parents: { "parent-doc-cccccccccc-0123": "P" },
      newCopyId: "copy-id-cccccccccccccccccc",
      copies: { "copy-id-cccccccccccccccccc": singleParaDoc("c", "x") },
    });
    const ver = await createVersion({
      projectId: p.id,
      createdByUserId: u.id,
    });
    expect(ver.parentVersionId).toBe(prev.id);
  });

  test("explicit parentVersionId: null pins parent to null even when prior versions exist", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-dddddddddd-0123" });
    await seedVersion({ projectId: p.id, createdByUserId: u.id, label: "v1" });
    stubDriveAndDocs({
      parents: { "parent-doc-dddddddddd-0123": "P" },
      newCopyId: "copy-id-dddddddddddddddddd",
      copies: { "copy-id-dddddddddddddddddd": singleParaDoc("c", "x") },
    });
    const ver = await createVersion({
      projectId: p.id,
      createdByUserId: u.id,
      parentVersionId: null,
    });
    expect(ver.parentVersionId).toBeNull();
  });

  test("explicit label overrides auto-numbering and the copy file is named with it", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-eeeeeeeeee-0123" });
    const log = stubDriveAndDocs({
      parents: { "parent-doc-eeeeeeeeee-0123": "Original" },
      newCopyId: "copy-id-eeeeeeeeeeeeeeeeee",
      copies: { "copy-id-eeeeeeeeeeeeeeeeee": singleParaDoc("c", "x") },
    });
    const ver = await createVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "draft-2026-05-13",
    });
    expect(ver.label).toBe("draft-2026-05-13");
    expect((log.copyCalls[0]?.body as { name?: string }).name).toBe(
      "[Margin draft-2026-05-13] Original",
    );
  });

  test("requireProject throws when projectId is unknown — no Drive call attempted", async () => {
    const log = stubDriveAndDocs({
      parents: {},
      newCopyId: "x",
      copies: {},
    });
    await expect(
      createVersion({
        projectId: "no-such-project",
        createdByUserId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no-such-project/);
    expect(log.getFileCalls).toHaveLength(0);
    expect(log.copyCalls).toHaveLength(0);
  });

  test("inserted row is what listVersions sees", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id, parentDocId: "parent-doc-ffffffffff-0123" });
    stubDriveAndDocs({
      parents: { "parent-doc-ffffffffff-0123": "P" },
      newCopyId: "copy-id-ffffffffffffffffff",
      copies: { "copy-id-ffffffffffffffffff": singleParaDoc("c", "x") },
    });
    const ver = await createVersion({ projectId: p.id, createdByUserId: u.id });
    const rows = await db
      .select()
      .from(version)
      .where(eq(version.id, ver.id));
    expect(rows[0]?.googleDocId).toBe("copy-id-ffffffffffffffffff");
  });
});
