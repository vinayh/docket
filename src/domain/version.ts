import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile } from "../google/drive.ts";
import { extractPlainText, getDocument } from "../google/docs.ts";
import { config } from "../config.ts";
import { requireProject } from "./project.ts";
import { subscribeVersionWatch } from "./watcher.ts";
import { paragraphHash } from "./anchor.ts";

export type Version = typeof version.$inferSelect;

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

  const label = opts.label ?? (await nextAutoLabel(proj.id));

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
    name: `[Margin ${label}] ${parentFile.name}`,
  });

  const doc = await getDocument(tp, copy.id);
  const snapshotContentHash = paragraphHash(extractPlainText(doc));

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

  // Best-effort: polling is the failure-mode safety net. Never block version creation on this.
  autoSubscribeWatch(ver.id).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`auto-subscribe failed for version ${ver.id}: ${msg}`);
  });

  return ver;
}

async function autoSubscribeWatch(versionId: string): Promise<void> {
  const baseUrl = config.publicBaseUrl;
  if (!baseUrl) return;
  const address = baseUrl.replace(/\/+$/, "") + "/webhooks/drive";
  await subscribeVersionWatch({ versionId, address });
}

// MAX+1 on parsed `v\d+` suffixes. Concurrent auto-labels can collide; the unique index
// on (project_id, label) surfaces that as a clean conflict rather than a dup row.
async function nextAutoLabel(projectId: string): Promise<string> {
  const rows = await db
    .select({ label: version.label })
    .from(version)
    .where(eq(version.projectId, projectId));
  return pickNextLabel(rows.map((r) => r.label));
}

// Non-matching labels are ignored: ["alpha", "v1", "v3"] → "v4". Empty → "v1".
export function pickNextLabel(existing: string[]): string {
  let max = 0;
  for (const label of existing) {
    const m = /^v(\d+)$/.exec(label);
    if (!m) continue;
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `v${max + 1}`;
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

// Returns null for both "no such version" and "not owned" so callers can 404 both —
// avoids leaking existence of versions in projects the caller can't see.
export async function loadOwnedVersion(
  versionId: string,
  userId: string,
): Promise<Version | null> {
  const rows = await db
    .select({ ver: version, ownerUserId: project.ownerUserId })
    .from(version)
    .innerJoin(project, eq(project.id, version.projectId))
    .where(eq(version.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.ownerUserId !== userId) return null;
  return row.ver;
}
