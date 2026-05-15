import { desc, eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile, trashFile } from "../google/drive.ts";
import { extractPlainText, getDocument } from "../google/docs.ts";
import { config } from "../config.ts";
import { requireProject } from "./project.ts";
import { subscribeVersionWatch } from "./watcher.ts";
import { paragraphHash } from "./anchor.ts";

export type Version = typeof version.$inferSelect;

const MAX_AUTO_LABEL_ATTEMPTS = 5;

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

  // User-supplied label: surface UNIQUE conflict directly — caller picked the value.
  // Auto-label: retry to absorb concurrent createVersion races. Each retry costs one Drive
  // copy; orphans from prior attempts are best-effort trashed.
  if (opts.label !== undefined) {
    const ver = await copyAndInsertVersion({
      tp,
      proj,
      parentFile,
      parentVersionId,
      label: opts.label,
      createdByUserId: opts.createdByUserId,
    });
    autoSubscribeWatch(ver.id).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`auto-subscribe failed for version ${ver.id}: ${msg}`);
    });
    return ver;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_AUTO_LABEL_ATTEMPTS; attempt++) {
    const label = await nextAutoLabel(proj.id);
    try {
      const ver = await copyAndInsertVersion({
        tp,
        proj,
        parentFile,
        parentVersionId,
        label,
        createdByUserId: opts.createdByUserId,
      });
      autoSubscribeWatch(ver.id).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`auto-subscribe failed for version ${ver.id}: ${msg}`);
      });
      return ver;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // The orphan Drive copy from this attempt was already trashed inside copyAndInsertVersion
      // before the throw. Loop to re-pick the label.
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("createVersion: exhausted label retries");
}

async function copyAndInsertVersion(opts: {
  tp: ReturnType<typeof tokenProviderForUser>;
  proj: { id: string; parentDocId: string };
  parentFile: { name: string };
  parentVersionId: string | null;
  label: string;
  createdByUserId: string;
}): Promise<Version> {
  const copy = await copyFile(opts.tp, opts.proj.parentDocId, {
    name: `[Margin ${opts.label}] ${opts.parentFile.name}`,
  });

  let snapshotContentHash: string;
  try {
    const doc = await getDocument(opts.tp, copy.id);
    snapshotContentHash = paragraphHash(extractPlainText(doc));
  } catch (err) {
    await trashFile(opts.tp, copy.id).catch(() => {});
    throw err;
  }

  try {
    const inserted = await db
      .insert(version)
      .values({
        projectId: opts.proj.id,
        googleDocId: copy.id,
        name: copy.name,
        parentVersionId: opts.parentVersionId,
        label: opts.label,
        createdByUserId: opts.createdByUserId,
        snapshotContentHash,
        status: "active",
      })
      .returning();
    return inserted[0]!;
  } catch (err) {
    // INSERT failed (label-race UNIQUE or otherwise) — the Drive copy is now orphaned.
    await trashFile(opts.tp, copy.id).catch((trashErr) => {
      const msg = trashErr instanceof Error ? trashErr.message : String(trashErr);
      console.warn(`createVersion: failed to trash orphan copy ${copy.id}: ${msg}`);
    });
    throw err;
  }
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
