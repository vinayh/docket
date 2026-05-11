import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  cleanDb,
  seedCanonicalComment,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { db } from "../db/client.ts";
import { canonicalComment } from "../db/schema.ts";
import { ingestExtensionCaptures, type CaptureInput } from "./capture.ts";

beforeEach(cleanDb);

function capture(overrides: Partial<CaptureInput> & { externalId: string; docId: string }): CaptureInput {
  return { body: "default body", ...overrides };
}

describe("ingestExtensionCaptures", () => {
  test("orphaned: capture for a doc Margin tracks but no parent suggestion exists", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-orphan" });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-orphan",
    });

    const result = await ingestExtensionCaptures(
      [capture({ externalId: "ext-1", docId: "doc-orphan", body: "stray reply" })],
      u.id,
    );
    expect(result.orphaned).toBe(1);
    expect(result.results[0]!.status).toBe("orphaned");
    // The orphaned reply still lands as a canonical_comment so a future
    // re-anchor can pick it up.
    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.originVersionId, ver.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("stray reply");
  });

  test("inserted: capture with kixDiscussionId matching a stamped suggestion", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-1" });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-1",
    });
    // Pre-existing parent suggestion with the kix id stamped on it.
    const parent = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: ver.id,
      kind: "suggestion_insert",
      anchor: { quotedText: "alpha" },
      kixDiscussionId: "kix.42",
    });

    const result = await ingestExtensionCaptures(
      [
        capture({
          externalId: "ext-reply-1",
          docId: "doc-1",
          body: "agreed",
          kixDiscussionId: "kix.42",
        }),
      ],
      u.id,
    );

    expect(result.inserted).toBe(1);
    expect(result.results[0]!.status).toBe("inserted");

    const reply = (
      await db
        .select()
        .from(canonicalComment)
        .where(eq(canonicalComment.externalId, "ext-reply-1"))
        .limit(1)
    )[0]!;
    expect(reply.parentCommentId).toBe(parent.id);
    expect(reply.kixDiscussionId).toBe("kix.42");
  });

  test("inserted via quoted-text fallback also stamps the matched parent's kix id", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-2" });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-2",
    });
    const parent = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: ver.id,
      kind: "suggestion_insert",
      anchor: { quotedText: "exact match" },
      // No kix id yet — quoted-text fallback handles this case.
    });

    const result = await ingestExtensionCaptures(
      [
        capture({
          externalId: "ext-r1",
          docId: "doc-2",
          body: "reply via quote",
          parentQuotedText: "exact match",
          kixDiscussionId: "kix.99",
        }),
      ],
      u.id,
    );
    expect(result.inserted).toBe(1);

    // Stamping side-effect: the parent now carries the kix id, so future
    // captures take the indexed path.
    const stamped = (
      await db
        .select()
        .from(canonicalComment)
        .where(eq(canonicalComment.id, parent.id))
        .limit(1)
    )[0]!;
    expect(stamped.kixDiscussionId).toBe("kix.99");
  });

  test("duplicate: re-posting the same (externalId, version) returns duplicate without inserting", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-dup" });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-dup",
    });

    const first = await ingestExtensionCaptures(
      [capture({ externalId: "ext-A", docId: "doc-dup" })],
      u.id,
    );
    expect(first.orphaned).toBe(1);

    const second = await ingestExtensionCaptures(
      [capture({ externalId: "ext-A", docId: "doc-dup", body: "different body" })],
      u.id,
    );
    expect(second.duplicate).toBe(1);
    expect(second.results[0]!.status).toBe("duplicate");

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.originVersionId, ver.id));
    // Only one row — the second submission did not write through.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("default body");
  });

  test("version_unknown: docId Margin doesn't track at all", async () => {
    const u = await seedUser();
    const result = await ingestExtensionCaptures(
      [capture({ externalId: "ext-x", docId: "doc-not-tracked" })],
      u.id,
    );
    expect(result.versionUnknown).toBe(1);
    expect(result.results[0]!.status).toBe("version_unknown");
  });

  test("cross-tenant: another user's tracked doc returns version_unknown (no leak)", async () => {
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    const aliceProj = await seedProject({
      ownerUserId: alice.id,
      parentDocId: "doc-tenant",
    });
    await seedVersion({
      projectId: aliceProj.id,
      createdByUserId: alice.id,
      googleDocId: "doc-tenant",
    });

    // Bob's API token tries to inject a comment into Alice's project's doc.
    const result = await ingestExtensionCaptures(
      [capture({ externalId: "ext-b", docId: "doc-tenant", body: "hi from bob" })],
      bob.id,
    );
    expect(result.versionUnknown).toBe(1);
    expect(result.results[0]!.status).toBe("version_unknown");

    // Confirm nothing landed in Alice's project.
    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, aliceProj.id));
    expect(rows).toHaveLength(0);
  });

  test("aggregate counts roll up across the batch", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-mix" });
    await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-mix",
    });

    const out = await ingestExtensionCaptures(
      [
        capture({ externalId: "e1", docId: "doc-mix", body: "first" }),
        capture({ externalId: "e1", docId: "doc-mix", body: "second" }), // dup
        capture({ externalId: "e2", docId: "doc-not-tracked" }),
      ],
      u.id,
    );
    expect(out.results).toHaveLength(3);
    expect(out.orphaned).toBe(1);
    expect(out.duplicate).toBe(1);
    expect(out.versionUnknown).toBe(1);
    expect(out.inserted).toBe(0);
    expect(out.errored).toBe(0);
  });
});
