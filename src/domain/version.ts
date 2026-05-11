import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
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

  // Best-effort: in production (MARGIN_PUBLIC_BASE_URL set), subscribe a
  // Drive `files.watch` channel so the doc-watcher picks up downstream
  // edits without operator intervention. Polling fallback covers the
  // failure case, so we never block version creation on this. The .catch
  // is mandatory at the call site — even if `autoSubscribeWatch` is later
  // refactored to throw, we don't want an unhandled rejection.
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

/**
 * Auto-assign the next `v<N>` label for a project. We parse the integer
 * suffix off existing labels and take MAX + 1, which is robust against:
 *   - archived versions still occupying their label
 *   - manual labels (skipped — any non `v\d+` label doesn't contribute)
 *   - any prior delete (we never delete versions, but parsing MAX is the
 *     correct primitive even if we someday do)
 *
 * Concurrency note: two `createVersion` calls landing simultaneously with
 * `opts.label === undefined` can still compute the same label. There's no
 * unique-constraint enforcement, so the second insert just succeeds with
 * a duplicate label. This is acceptable for now — auto-labelling concurrent
 * versions is an unusual pattern, and the operator can always pass an
 * explicit `--label` to disambiguate.
 */
async function nextAutoLabel(projectId: string): Promise<string> {
  const rows = await db
    .select({ label: version.label })
    .from(version)
    .where(eq(version.projectId, projectId));
  return pickNextLabel(rows.map((r) => r.label));
}

/**
 * Pure helper exposed for tests: parse `v\d+` labels and return `v<MAX+1>`.
 * Non-matching labels are ignored, so a project with `["alpha", "v1", "v3"]`
 * yields `v4`. Empty input → `v1`.
 */
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

export async function archiveVersion(id: string): Promise<void> {
  await db.update(version).set({ status: "archived" }).where(eq(version.id, id));
}

/**
 * Owner-scoped version lookup. Returns the version when it exists AND the
 * caller is the project owner, otherwise `null`. Collapsing both "no such
 * version" and "version not owned by caller" into the same null result is
 * intentional: callers map it to a 404 so the response can't be used to
 * probe for the existence of versions in projects the caller can't see.
 */
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
