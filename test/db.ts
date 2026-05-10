/**
 * Helpers for tests that read/write the DB. The DB itself is provisioned by
 * `test/setup.ts` (preloaded via `bunfig.toml`) — by the time these helpers
 * import `src/db/client.ts`, `DOCKET_DB_PATH` already points at a temp file
 * and `drizzle-kit` migrations have run.
 *
 * Test isolation: every `bun test` process gets one shared temp DB. Tests
 * that need a clean slate call `cleanDb()` in `beforeEach` — there's no
 * cross-process state, so this is sufficient even with parallel test files.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import {
  apiToken,
  canonicalComment,
  commentProjection,
  derivative,
  driveCredential,
  driveWatchChannel,
  overlay,
  overlayOperation,
  project,
  reviewAssignment,
  reviewRequest,
  user,
  version,
  type AuthMethod,
  type CanonicalCommentKind,
  type CommentAnchor,
  type ProjectionStatus,
  type ReviewRequestStatus,
} from "../src/db/schema.ts";

/**
 * Truncate every table. Order matters because of FK cascades — children
 * before parents (we still bypass FK pragmas for the duration to keep the
 * statements composable in any order if a future migration adds a cycle).
 */
export async function cleanDb(): Promise<void> {
  // Disable FKs while we wipe — sqlite can't `TRUNCATE`, and one table at a
  // time would otherwise need careful child-first ordering on every schema
  // change.
  db.run(sql`PRAGMA foreign_keys = OFF`);
  for (const t of [
    reviewAssignment,
    reviewRequest,
    commentProjection,
    canonicalComment,
    derivative,
    overlayOperation,
    overlay,
    driveWatchChannel,
    version,
    project,
    driveCredential,
    apiToken,
    user,
  ]) {
    await db.delete(t);
  }
  db.run(sql`PRAGMA foreign_keys = ON`);
}

export async function seedUser(opts?: {
  email?: string;
  authMethod?: AuthMethod;
  googleSubjectId?: string;
  displayName?: string;
}): Promise<typeof user.$inferSelect> {
  const inserted = await db
    .insert(user)
    .values({
      email: opts?.email ?? `user-${crypto.randomUUID()}@example.com`,
      authMethod: opts?.authMethod ?? "google",
      googleSubjectId: opts?.googleSubjectId ?? null,
      displayName: opts?.displayName ?? null,
    })
    .returning();
  return inserted[0]!;
}

export async function seedProject(opts: {
  ownerUserId: string;
  parentDocId?: string;
}): Promise<typeof project.$inferSelect> {
  const inserted = await db
    .insert(project)
    .values({
      ownerUserId: opts.ownerUserId,
      parentDocId: opts.parentDocId ?? `doc-${crypto.randomUUID()}`,
      settings: {},
    })
    .returning();
  return inserted[0]!;
}

export async function seedVersion(opts: {
  projectId: string;
  createdByUserId: string;
  label?: string;
  googleDocId?: string;
  parentVersionId?: string | null;
}): Promise<typeof version.$inferSelect> {
  const inserted = await db
    .insert(version)
    .values({
      projectId: opts.projectId,
      googleDocId: opts.googleDocId ?? `doc-${crypto.randomUUID()}`,
      label: opts.label ?? "v1",
      createdByUserId: opts.createdByUserId,
      parentVersionId: opts.parentVersionId ?? null,
      status: "active",
    })
    .returning();
  return inserted[0]!;
}

export async function seedOverlay(opts: {
  projectId: string;
  name?: string;
}): Promise<typeof overlay.$inferSelect> {
  const inserted = await db
    .insert(overlay)
    .values({
      projectId: opts.projectId,
      name: opts.name ?? "test overlay",
    })
    .returning();
  return inserted[0]!;
}

export async function seedDerivative(opts: {
  projectId: string;
  versionId: string;
  overlayId: string;
  googleDocId?: string;
  audienceLabel?: string | null;
}): Promise<typeof derivative.$inferSelect> {
  const inserted = await db
    .insert(derivative)
    .values({
      projectId: opts.projectId,
      versionId: opts.versionId,
      overlayId: opts.overlayId,
      googleDocId: opts.googleDocId ?? `doc-${crypto.randomUUID()}`,
      audienceLabel: opts.audienceLabel ?? null,
    })
    .returning();
  return inserted[0]!;
}

export async function seedReviewRequest(opts: {
  projectId: string;
  versionId: string;
  createdByUserId: string;
  status?: ReviewRequestStatus;
  deadline?: Date | null;
}): Promise<typeof reviewRequest.$inferSelect> {
  const inserted = await db
    .insert(reviewRequest)
    .values({
      projectId: opts.projectId,
      versionId: opts.versionId,
      createdByUserId: opts.createdByUserId,
      status: opts.status ?? "open",
      deadline: opts.deadline ?? null,
    })
    .returning();
  return inserted[0]!;
}

export async function seedCommentProjection(opts: {
  canonicalCommentId: string;
  versionId: string;
  projectionStatus?: ProjectionStatus;
  lastSyncedAt?: Date;
  googleCommentId?: string | null;
  anchorMatchConfidence?: number | null;
}): Promise<typeof commentProjection.$inferSelect> {
  const inserted = await db
    .insert(commentProjection)
    .values({
      canonicalCommentId: opts.canonicalCommentId,
      versionId: opts.versionId,
      googleCommentId: opts.googleCommentId ?? null,
      anchorMatchConfidence: opts.anchorMatchConfidence ?? null,
      projectionStatus: opts.projectionStatus ?? "clean",
      lastSyncedAt: opts.lastSyncedAt ?? new Date(),
    })
    .returning();
  return inserted[0]!;
}

export async function seedDriveWatchChannel(opts: {
  versionId: string;
  channelId?: string;
  resourceId?: string;
  expiration?: Date;
  lastSyncedAt?: Date;
}): Promise<typeof driveWatchChannel.$inferSelect> {
  const inserted = await db
    .insert(driveWatchChannel)
    .values({
      versionId: opts.versionId,
      channelId: opts.channelId ?? `channel-${crypto.randomUUID()}`,
      resourceId: opts.resourceId ?? `resource-${crypto.randomUUID()}`,
      address: "https://example.com/webhooks/drive",
      expiration: opts.expiration ?? new Date(Date.now() + 86_400_000),
      lastSyncedAt: opts.lastSyncedAt ?? new Date(),
    })
    .returning();
  return inserted[0]!;
}

export async function seedCanonicalComment(opts: {
  projectId: string;
  originVersionId: string;
  body?: string;
  kind?: CanonicalCommentKind;
  anchor?: CommentAnchor;
  externalId?: string;
  kixDiscussionId?: string;
}): Promise<typeof canonicalComment.$inferSelect> {
  const inserted = await db
    .insert(canonicalComment)
    .values({
      projectId: opts.projectId,
      originVersionId: opts.originVersionId,
      originTimestamp: new Date(),
      body: opts.body ?? "test comment",
      kind: opts.kind ?? "comment",
      anchor: opts.anchor ?? { quotedText: "" },
      externalId: opts.externalId ?? null,
      kixDiscussionId: opts.kixDiscussionId ?? null,
    })
    .returning();
  return inserted[0]!;
}
