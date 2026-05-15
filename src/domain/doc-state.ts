import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import {
  countComments,
  countOpenReviews,
  pickLastSyncedAt,
} from "./stats.ts";
import { userEmailById } from "./user.ts";

/**
 * Result of a popup / extension state query for the active doc.
 *
 * `tracked: false` is the no-project, no-version case — the caller renders
 * the onboarding affordance (Picker / add-on flow). When `tracked: true`,
 * `role` distinguishes:
 *   - `parent`  → the open doc IS the project's parent doc
 *   - `version` → the open doc IS one of the project's version copies
 *
 * For both, `commentCount` and `openReviewCount` are project-wide totals so
 * the popup can show lifetime activity. `lastSyncedAt` is per-relevant-version
 * (latest active for parent, the version itself for version): it answers
 * "when did Margin last refresh comments for what I'm looking at" rather
 * than the broader "when did anything sync."
 */
export type DocStateResponse =
  | { tracked: false; docId: string }
  | {
      tracked: true;
      docId: string;
      role: "parent" | "version";
      // Authoritative Drive name for the doc the user is currently viewing —
      // `version.name` when role=version, else `project.name`. Null only for
      // pre-name-column rows; the extension falls back to the tab-title
      // heuristic in that case.
      title: string | null;
      project: {
        id: string;
        parentDocId: string;
        name: string | null;
        ownerEmail: string | null;
        createdAt: number;
      };
      version: {
        id: string;
        label: string;
        googleDocId: string;
        name: string | null;
        status: "active" | "archived";
        createdAt: number;
      } | null;
      lastSyncedAt: number | null;
      commentCount: number;
      openReviewCount: number;
    };

export async function getDocState(opts: {
  docId: string;
  userId: string;
}): Promise<DocStateResponse> {
  const projectRow = (
    await db
      .select()
      .from(project)
      .where(
        and(
          eq(project.parentDocId, opts.docId),
          eq(project.ownerUserId, opts.userId),
        ),
      )
      .limit(1)
  )[0];

  if (projectRow) {
    // Parent doc is registered as the "main" version (see createProject).
    // Resolve it directly so the parent-role response carries main's stats
    // (comment count, last sync) rather than falling back to the
    // most-recently-created snapshot — matches what the user actually sees
    // in the open tab.
    const mainRows = await db
      .select()
      .from(version)
      .where(
        and(
          eq(version.projectId, projectRow.id),
          eq(version.label, "main"),
        ),
      )
      .limit(1);
    return buildTrackedState({
      docId: opts.docId,
      role: "parent",
      projectId: projectRow.id,
      ownerUserId: projectRow.ownerUserId,
      parentDocId: projectRow.parentDocId,
      projectName: projectRow.name,
      projectCreatedAt: projectRow.createdAt,
      preferredVersionId: mainRows[0]?.id ?? null,
    });
  }

  const versionRow = (
    await db
      .select({
        v: version,
        ownerUserId: project.ownerUserId,
        parentDocId: project.parentDocId,
        projectName: project.name,
        projectCreatedAt: project.createdAt,
      })
      .from(version)
      .innerJoin(project, eq(project.id, version.projectId))
      .where(
        and(
          eq(version.googleDocId, opts.docId),
          eq(project.ownerUserId, opts.userId),
        ),
      )
      .limit(1)
  )[0];

  if (versionRow) {
    return buildTrackedState({
      docId: opts.docId,
      role: "version",
      projectId: versionRow.v.projectId,
      ownerUserId: versionRow.ownerUserId,
      parentDocId: versionRow.parentDocId,
      projectName: versionRow.projectName,
      projectCreatedAt: versionRow.projectCreatedAt,
      preferredVersionId: versionRow.v.id,
    });
  }

  return { tracked: false, docId: opts.docId };
}

interface BuildArgs {
  docId: string;
  role: "parent" | "version";
  projectId: string;
  ownerUserId: string;
  parentDocId: string;
  projectName: string | null;
  projectCreatedAt: Date;
  /** When set, scope `version` + `lastSyncedAt` to that version row. */
  preferredVersionId: string | null;
}

async function buildTrackedState(
  args: BuildArgs,
): Promise<Extract<DocStateResponse, { tracked: true }>> {
  const ver = await pickRelevantVersion(args.projectId, args.preferredVersionId);
  const lastSynced = ver ? await pickLastSyncedAt(ver.id) : null;
  const commentCount = await countComments(args.projectId);
  const openReviewCount = await countOpenReviews(args.projectId);
  const ownerEmail = await userEmailById(args.ownerUserId);
  const title = args.role === "version" ? (ver?.name ?? null) : args.projectName;

  return {
    tracked: true,
    docId: args.docId,
    role: args.role,
    title,
    project: {
      id: args.projectId,
      parentDocId: args.parentDocId,
      name: args.projectName,
      ownerEmail,
      createdAt: args.projectCreatedAt.getTime(),
    },
    version: ver
      ? {
          id: ver.id,
          label: ver.label,
          googleDocId: ver.googleDocId,
          name: ver.name,
          status: ver.status,
          createdAt: ver.createdAt.getTime(),
        }
      : null,
    lastSyncedAt: lastSynced,
    commentCount,
    openReviewCount,
  };
}

async function pickRelevantVersion(
  projectId: string,
  preferredVersionId: string | null,
): Promise<typeof version.$inferSelect | null> {
  if (preferredVersionId) {
    const rows = await db
      .select()
      .from(version)
      .where(eq(version.id, preferredVersionId))
      .limit(1);
    return rows[0] ?? null;
  }
  const active = await db
    .select()
    .from(version)
    .where(and(eq(version.projectId, projectId), eq(version.status, "active")))
    .orderBy(desc(version.createdAt))
    .limit(1);
  if (active[0]) return active[0];
  const any = await db
    .select()
    .from(version)
    .where(eq(version.projectId, projectId))
    .orderBy(desc(version.createdAt))
    .limit(1);
  return any[0] ?? null;
}

