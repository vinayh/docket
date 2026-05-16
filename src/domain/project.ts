import { and, desc, eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.ts";
import { project, version, type ProjectSettings } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import type { TokenProvider } from "../google/api.ts";
import { getFile } from "../google/drive.ts";
import { extractPlainText, getDocument } from "../google/docs.ts";
import { config } from "../config.ts";
import { paragraphHash } from "./anchor.ts";
import { parseGoogleDocId } from "./google-doc-url.ts";
import { subscribeVersionWatch } from "./watcher.ts";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export type Project = typeof project.$inferSelect;

// Carries the existing project id so callers can render an "already tracked" state.
export class DuplicateProjectError extends Error {
  readonly projectId: string;
  readonly parentDocId: string;
  constructor(projectId: string, parentDocId: string) {
    super(`project for doc ${parentDocId} already exists (id=${projectId})`);
    this.name = "DuplicateProjectError";
    this.projectId = projectId;
    this.parentDocId = parentDocId;
  }
}

export async function createProject(opts: {
  ownerUserId: string;
  parentDocUrlOrId: string;
  settings?: ProjectSettings;
}): Promise<Project> {
  const parentDocId = parseGoogleDocId(opts.parentDocUrlOrId);

  // Cheap dup check before the Drive round-trip.
  const preExisting = await loadExistingProject(parentDocId, opts.ownerUserId);
  if (preExisting) {
    throw new DuplicateProjectError(preExisting.id, parentDocId);
  }

  const tp = tokenProviderForUser(opts.ownerUserId);
  const file = await getFile(tp, parentDocId);
  if (file.mimeType !== GOOGLE_DOC_MIME) {
    throw new Error(
      `expected a Google Doc (mimeType=${GOOGLE_DOC_MIME}), got ${file.mimeType} for ${parentDocId}`,
    );
  }
  if (file.trashed) {
    throw new Error(`doc ${parentDocId} is in the trash`);
  }

  // Project identity is decoupled from parent_doc_id, so the DB no longer
  // enforces uniqueness. The pre-check above is the only "already tracked"
  // guard, surfaced as DuplicateProjectError for picker UX. A racing insert
  // past the pre-check is allowed through — the user can swap the parent
  // doc later or use the soft duplicate as intended.
  const rows = await db
    .insert(project)
    .values({
      parentDocId,
      name: file.name,
      ownerUserId: opts.ownerUserId,
      settings: opts.settings ?? {},
    })
    .returning();
  const inserted: Project = rows[0]!;

  // Insert the "main" version immediately: the parent doc IS the live
  // editable doc, so every project starts with a versions list of length 1
  // labelled "main". Comments authored on the parent doc then flow through
  // `ingestVersionComments` like any other version (without this, parent-doc
  // comments were silently dropped because there was no version row to
  // project them onto). Subsequent snapshots are v1, v2, … (pickNextLabel
  // skips non-`v\d+` labels, so the auto-labeller treats "main" as outside
  // the sequence).
  //
  // snapshotContentHash failure is non-fatal: the polling loop will populate
  // it on next run, and the main row still serves as the row that all later
  // versions' `parentVersionId` chains terminate at.
  let snapshotContentHash: string | null = null;
  try {
    const doc = await getDocument(tp, parentDocId);
    snapshotContentHash = paragraphHash(extractPlainText(doc));
  } catch (err) {
    console.warn(
      `createProject: parent doc snapshot hash failed for ${parentDocId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const mainRows = await db
    .insert(version)
    .values({
      projectId: inserted.id,
      googleDocId: parentDocId,
      name: file.name,
      parentVersionId: null,
      label: "main",
      createdByUserId: opts.ownerUserId,
      snapshotContentHash,
      status: "active",
    })
    .returning();
  const mainVer = mainRows[0]!;

  // Subscribe a Drive watch channel on main so parent-doc edits flow into the
  // polling/webhook loop. Best-effort: same pattern as createVersion.
  void autoSubscribeWatch(mainVer.id);

  return inserted;
}

async function autoSubscribeWatch(versionId: string): Promise<void> {
  const baseUrl = config.publicBaseUrl;
  if (!baseUrl) return;
  const address = baseUrl.replace(/\/+$/, "") + "/webhooks/drive";
  try {
    await subscribeVersionWatch({ versionId, address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`createProject: watch subscribe failed for version ${versionId}: ${msg}`);
  }
}

async function loadExistingProject(
  parentDocId: string,
  ownerUserId: string,
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(project)
    .where(
      and(eq(project.parentDocId, parentDocId), eq(project.ownerUserId, ownerUserId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getProject(id: string): Promise<Project | null> {
  const rows = await db.select().from(project).where(eq(project.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function requireProject(id: string): Promise<Project> {
  const proj = await getProject(id);
  if (!proj) throw new Error(`project ${id} not found`);
  return proj;
}

export async function listAllProjects(): Promise<Project[]> {
  return db.select().from(project);
}

export async function listProjectsOwnedBy(
  userId: string,
): Promise<Project[]> {
  return db
    .select()
    .from(project)
    .where(eq(project.ownerUserId, userId))
    .orderBy(desc(project.createdAt));
}

// Returns null for both "no such project" and "not owned" so callers 404 both —
// prevents probing for the existence of projects the caller can't see.
export async function getOwnedProject(
  projectId: string,
  userId: string,
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.ownerUserId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function tokenProviderForProject(projectId: string): Promise<TokenProvider> {
  const proj = await requireProject(projectId);
  return tokenProviderForUser(proj.ownerUserId);
}

/**
 * Owner-scoped project deletion. Returns true when a row was deleted, false
 * when nothing matched (either the project doesn't exist or the caller isn't
 * the owner — same no-info-leak posture as the read paths). All descendants
 * (versions, overlays, comments, review requests, derivatives, drive watches,
 * audit log) cascade via FKs declared in schema.ts.
 */
export async function deleteOwnedProject(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(project)
    .where(and(eq(project.id, projectId), eq(project.ownerUserId, userId)))
    .returning({ id: project.id });
  return rows.length > 0;
}

/**
 * Lazy backfill for projects created before the createProject change that
 * auto-inserts a "main" version row pointing at the parent doc. Idempotent —
 * if a main row already exists (or a row already points at the parent doc
 * under any label), this is a no-op. Called on read from getProjectDetail
 * and getDocState so legacy projects appear with their parent doc as a
 * version on first dashboard load, without forcing a migration that would
 * need Drive credentials.
 */
export async function ensureMainVersion(proj: Project): Promise<void> {
  const existing = await db
    .select({ id: version.id })
    .from(version)
    .where(
      and(
        eq(version.projectId, proj.id),
        eq(version.googleDocId, proj.parentDocId),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  try {
    await db.insert(version).values({
      projectId: proj.id,
      googleDocId: proj.parentDocId,
      name: proj.name,
      parentVersionId: null,
      label: "main",
      createdByUserId: proj.ownerUserId,
      snapshotContentHash: null,
      status: "active",
      createdAt: proj.createdAt,
    });
  } catch (err) {
    // The (project_id, label) unique index can collide if the project
    // happens to have a manually-labelled "main" row already. Treat as a
    // no-op — the user's existing labelling wins.
    if (!isUniqueConstraintError(err)) throw err;
  }
}
