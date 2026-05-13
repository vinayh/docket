import { and, desc, eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.ts";
import { project, type ProjectSettings } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import type { TokenProvider } from "../google/api.ts";
import { getFile } from "../google/drive.ts";
import { parseGoogleDocId } from "./google-doc-url.ts";

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

  // The unique index is the source of truth. A race past the pre-check surfaces here.
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
