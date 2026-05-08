import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile } from "../google/drive.ts";
import { extractPlainText, getDocument } from "../google/docs.ts";

export type Version = typeof version.$inferSelect;

function sha256Hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export async function createVersion(opts: {
  projectId: string;
  createdByUserId: string;
  label?: string;
  // undefined => auto-link to the most recent version; null => no parent.
  parentVersionId?: string | null;
}): Promise<Version> {
  const proj = (
    await db.select().from(project).where(eq(project.id, opts.projectId)).limit(1)
  )[0];
  if (!proj) throw new Error(`project ${opts.projectId} not found`);

  const tp = tokenProviderForUser(proj.ownerUserId);
  const parentFile = await getFile(tp, proj.parentDocId, { fields: "id,name" });

  const existing = await db
    .select({ id: version.id })
    .from(version)
    .where(eq(version.projectId, proj.id));
  const label = opts.label ?? `v${existing.length + 1}`;

  let parentVersionId: string | null;
  if (opts.parentVersionId === undefined) {
    const previous = await db
      .select({ id: version.id })
      .from(version)
      .where(eq(version.projectId, proj.id))
      .orderBy(desc(version.createdAt))
      .limit(1);
    parentVersionId = previous[0]?.id ?? null;
  } else {
    parentVersionId = opts.parentVersionId;
  }

  const copy = await copyFile(tp, proj.parentDocId, {
    name: `[Docket ${label}] ${parentFile.name}`,
  });

  const doc = await getDocument(tp, copy.id);
  const snapshotContentHash = sha256Hex(extractPlainText(doc));

  const inserted = await db
    .insert(version)
    .values({
      projectId: proj.id,
      googleDocId: copy.id,
      parentVersionId,
      label,
      createdByUserId: opts.createdByUserId,
      snapshotContentHash,
      status: "active",
    })
    .returning();
  return inserted[0]!;
}

export async function listVersions(projectId: string): Promise<Version[]> {
  return db
    .select()
    .from(version)
    .where(eq(version.projectId, projectId))
    .orderBy(desc(version.createdAt));
}

export async function getVersion(id: string): Promise<Version | null> {
  const rows = await db.select().from(version).where(eq(version.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function archiveVersion(id: string): Promise<void> {
  await db.update(version).set({ status: "archived" }).where(eq(version.id, id));
}
