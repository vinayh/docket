import { and, eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.ts";
import { project, type ProjectSettings } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import type { TokenProvider } from "../google/api.ts";
import { getFile } from "../google/drive.ts";
import { parseGoogleDocId } from "./google-doc-url.ts";

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export type Project = typeof project.$inferSelect;

/**
 * Thrown by `createProject` when the parent doc is already registered.
 * Carries the existing project id so callers can render a "already tracked"
 * state without parsing prose.
 */
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

  // First pass: cheap existence check that avoids the Drive round-trip when
  // the doc is already a project for this owner.
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

  // The unique index on (parent_doc_id, owner_user_id) is the source of truth.
  // Two concurrent register-doc posts can both pass the pre-check above; the
  // loser of the race surfaces here as a unique-constraint error, which we
  // translate into `DuplicateProjectError` by re-reading the winner.
  try {
    const inserted = await db
      .insert(project)
      .values({
        parentDocId,
        ownerUserId: opts.ownerUserId,
        settings: opts.settings ?? {},
      })
      .returning();
    return inserted[0]!;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const winner = await loadExistingProject(parentDocId, opts.ownerUserId);
    if (!winner) throw err;
    throw new DuplicateProjectError(winner.id, parentDocId);
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

/**
 * Like `getProject` but throws if the row is missing. Use this for the
 * common "look up project, fail loudly if it doesn't exist" path; reserve
 * the nullable `getProject` for code that genuinely wants to branch on
 * existence (e.g. "is this doc already a project?" checks).
 */
export async function requireProject(id: string): Promise<Project> {
  const proj = await getProject(id);
  if (!proj) throw new Error(`project ${id} not found`);
  return proj;
}

export async function listAllProjects(): Promise<Project[]> {
  return db.select().from(project);
}

/**
 * Owner-scoped project lookup. Returns the project when it exists AND the
 * caller is the owner; otherwise `null`. Collapsing both "no such project"
 * and "project not owned by caller" into the same null result is intentional:
 * callers map it to a 404 so the response can't be used to probe for the
 * existence of projects the caller can't see.
 */
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

/**
 * Resolve a project id straight to a Drive/Docs token provider for its owner.
 * Use this at sites whose only reason to fetch the project is to get the
 * owner's `userId`. Sites that need other project fields should call
 * `requireProject` directly and pass `proj.ownerUserId` to
 * `tokenProviderForUser` themselves.
 */
export async function tokenProviderForProject(projectId: string): Promise<TokenProvider> {
  const proj = await requireProject(projectId);
  return tokenProviderForUser(proj.ownerUserId);
}
