import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { version } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile } from "../google/drive.ts";
import { extractPlainText, getDocument } from "../google/docs.ts";
import { config } from "../config.ts";
import { requireProject } from "./project.ts";
import { subscribeVersionWatch } from "./watcher.ts";

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
  const proj = await requireProject(opts.projectId);
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
  const ver = inserted[0]!;

  // Best-effort: in production (DOCKET_PUBLIC_BASE_URL set), subscribe a
  // Drive `files.watch` channel so the doc-watcher picks up downstream
  // edits without operator intervention. Polling fallback covers the
  // failure case, so we never block version creation on this.
  void autoSubscribeWatch(ver.id);

  return ver;
}

async function autoSubscribeWatch(versionId: string): Promise<void> {
  const baseUrl = config.publicBaseUrl;
  if (!baseUrl) return;
  const address = baseUrl.replace(/\/+$/, "") + "/webhooks/drive";
  try {
    await subscribeVersionWatch({ versionId, address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`auto-subscribe failed for version ${versionId}: ${msg}`);
  }
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

export async function requireVersion(id: string): Promise<Version> {
  const ver = await getVersion(id);
  if (!ver) throw new Error(`version ${id} not found`);
  return ver;
}

export async function archiveVersion(id: string): Promise<void> {
  await db.update(version).set({ status: "archived" }).where(eq(version.id, id));
}
