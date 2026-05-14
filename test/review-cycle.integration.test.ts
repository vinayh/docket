/**
 * Live-Google integration test for the extension's review-cycle happy path.
 *
 * Exercises the same domain helpers the side panel calls under the hood:
 *   1. createProject against a real (freshly-created) Google Doc
 *   2. createVersion (Drive `files.copy`)
 *   3. ingestVersionComments (Drive `files.export?mimeType=docx`)
 *   4. createReviewRequest (Drive `permissions.create` + magic-link mint)
 *   5. redeemReviewActionToken (assignment.status flips)
 *
 * Gating: `integrationTest` skips when `GOOGLE_CI_REFRESH_TOKEN` / the OAuth
 * client vars aren't set, so unit-test runs aren't blocked. `MARGIN_MASTER_KEY`
 * is required too — `encryptWithMaster` reads it lazily.
 *
 * Cleanup: every Drive doc created during the test is deleted in `afterAll`,
 * even when the test body throws. Cleanup failures are logged but don't fail
 * the test (the docs are inert junk on the CI Drive account).
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { hasIntegrationCreds, integrationTest } from "./integration.ts";
import { cleanDb } from "./db.ts";
import { db } from "../src/db/client.ts";
import { account, reviewAssignment, user } from "../src/db/schema.ts";
import { encryptWithMaster } from "../src/auth/encryption.ts";
import { tokenProviderForUser } from "../src/auth/credentials.ts";
import type { TokenProvider } from "../src/google/api.ts";
import { authedFetch } from "../src/google/api.ts";
import { createProject } from "../src/domain/project.ts";
import { createVersion } from "../src/domain/version.ts";
import { ingestVersionComments } from "../src/domain/comments.ts";
import { createReviewRequest } from "../src/domain/review.ts";
import { redeemReviewActionToken } from "../src/domain/review-action.ts";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

let userId = "";
let ownerEmail = "";
const docsToDelete: string[] = [];

async function createBlankGoogleDoc(
  tp: TokenProvider,
  name: string,
): Promise<{ id: string }> {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id");
  const res = await authedFetch(tp, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.document",
    }),
  });
  if (!res.ok) {
    throw new Error(`files.create: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

async function deleteGoogleDoc(tp: TokenProvider, fileId: string): Promise<void> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await authedFetch(tp, url, { method: "DELETE" });
  // 204 = deleted; 404 = already gone. Anything else: log + ignore (cleanup is best-effort).
  if (!res.ok && res.status !== 404) {
    console.warn(`cleanup: files.delete ${fileId} → ${res.status} ${await res.text()}`);
  }
}

async function fetchOwnerEmail(tp: TokenProvider): Promise<string> {
  const res = await authedFetch(
    tp,
    new URL("https://www.googleapis.com/oauth2/v3/userinfo"),
  );
  if (!res.ok) {
    throw new Error(`userinfo: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as { email?: string };
  if (!j.email) throw new Error("userinfo returned no email");
  return j.email;
}

describe("review cycle (live Google)", () => {
  beforeAll(async () => {
    if (!hasIntegrationCreds) return;
    await cleanDb();
    const [u] = await db
      .insert(user)
      .values({ email: "ci-test@example.com", name: "CI Test" })
      .returning();
    userId = u!.id;
    await db.insert(account).values({
      userId,
      providerId: "google",
      accountId: `sub-${userId}`,
      scope:
        "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
      refreshToken: await encryptWithMaster(Bun.env.GOOGLE_CI_REFRESH_TOKEN!),
    });
    const tp = tokenProviderForUser(userId);
    ownerEmail = await fetchOwnerEmail(tp);
  });

  afterAll(async () => {
    if (!hasIntegrationCreds || !userId) return;
    const tp = tokenProviderForUser(userId);
    for (const id of docsToDelete) {
      try {
        await deleteGoogleDoc(tp, id);
      } catch (err) {
        console.warn(`cleanup: deleteGoogleDoc(${id}) threw:`, err);
      }
    }
  });

  integrationTest(
    "create → snapshot → ingest → review request → redeem",
    async () => {
      const tp = tokenProviderForUser(userId);

      // 1. Fresh parent doc on Drive. Name carries a timestamp so leftover docs
      //    from a failed prior run are easy to spot if cleanup didn't fire.
      const parent = await createBlankGoogleDoc(
        tp,
        `Margin CI parent ${new Date().toISOString()}`,
      );
      docsToDelete.push(parent.id);

      // 2. Register as a project. Hits Drive files.get internally to validate the mime type.
      const proj = await createProject({
        ownerUserId: userId,
        parentDocUrlOrId: parent.id,
      });
      expect(proj.parentDocId).toBe(parent.id);
      expect(proj.ownerUserId).toBe(userId);

      // 3. Snapshot a version (Drive files.copy + Docs documents.get).
      const ver = await createVersion({
        projectId: proj.id,
        createdByUserId: userId,
      });
      expect(ver.googleDocId).not.toBe(parent.id);
      expect(ver.label).toBe("v1");
      docsToDelete.push(ver.googleDocId);

      // 4. Docx-export ingest. A blank doc has no comments → all counters zero.
      //    Verifies the export endpoint, OOXML parse, and DB write path.
      const ingest = await ingestVersionComments(ver.id);
      expect(ingest.versionId).toBe(ver.id);
      expect(ingest.fetched).toBe(0);
      expect(ingest.inserted).toBe(0);

      // 5. Review request. Sharing the doc back to the owner returns 4xx from
      //    Drive ("can't share to yourself" / "already a writer"), which the
      //    domain catches per-assignee — magic links still mint.
      const sent: { to: string; subject: string }[] = [];
      const result = await createReviewRequest({
        versionId: ver.id,
        ownerUserId: userId,
        assigneeEmails: [ownerEmail],
        emailTransport: {
          async send(msg) {
            sent.push({ to: msg.to, subject: msg.subject });
          },
        },
      });
      expect(result.assignees).toHaveLength(1);
      expect(result.assignees[0]!.links).toHaveLength(3);
      expect(result.assignees[0]!.emailError).toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(ownerEmail);

      // 6. Redeem one magic link → assignment.status flips pending → reviewed.
      const markReviewedUrl = result.assignees[0]!.links.find(
        (l) => l.action === "mark_reviewed",
      )!.url;
      const tokenSegment = markReviewedUrl.split("/r/").at(-1)!;
      const redemption = await redeemReviewActionToken(tokenSegment);
      expect(redemption.ok).toBe(true);
      if (redemption.ok) {
        expect(redemption.assignmentStatus).toBe("reviewed");
      }

      const [assignment] = await db
        .select()
        .from(reviewAssignment)
        .where(eq(reviewAssignment.reviewRequestId, result.reviewRequestId))
        .limit(1);
      expect(assignment!.status).toBe("reviewed");
      expect(assignment!.respondedAt).not.toBeNull();
    },
    // Real network: be generous. files.copy + export+parse usually fit
    // well under this, but a cold Drive backend can spike.
    120_000,
  );
});
