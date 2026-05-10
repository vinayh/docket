import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
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

  const existing = await db
    .select()
    .from(project)
    .where(
      and(
        eq(project.parentDocId, parentDocId),
        eq(project.ownerUserId, opts.ownerUserId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new DuplicateProjectError(existing[0].id, parentDocId);
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

  const inserted = await db
    .insert(project)
    .values({
      parentDocId,
      ownerUserId: opts.ownerUserId,
      settings: opts.settings ?? {},
    })
    .returning();
  return inserted[0]!;
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

export async function listProjectsForOwner(ownerUserId: string): Promise<Project[]> {
  return db.select().from(project).where(eq(project.ownerUserId, ownerUserId));
}

export async function listAllProjects(): Promise<Project[]> {
  return db.select().from(project);
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
