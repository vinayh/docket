import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, type ProjectSettings } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { getFile } from "../google/drive.ts";
import { parseGoogleDocId } from "./google-doc-url.ts";

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export type Project = typeof project.$inferSelect;

export async function createProject(opts: {
  ownerUserId: string;
  parentDocUrlOrId: string;
  settings?: ProjectSettings;
}): Promise<Project> {
  const parentDocId = parseGoogleDocId(opts.parentDocUrlOrId);

  const existing = await db
    .select()
    .from(project)
    .where(eq(project.parentDocId, parentDocId))
    .limit(1);
  if (existing[0]) {
    throw new Error(
      `project for doc ${parentDocId} already exists (id=${existing[0].id})`,
    );
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

export async function listProjectsForOwner(ownerUserId: string): Promise<Project[]> {
  return db.select().from(project).where(eq(project.ownerUserId, ownerUserId));
}

export async function listAllProjects(): Promise<Project[]> {
  return db.select().from(project);
}
