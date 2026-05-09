import { asc, eq, lt, or, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  driveWatchChannel,
  version,
  type VersionStatus,
} from "../db/schema.ts";
import { stopChannel, watchFile } from "../google/drive.ts";
import { tokenProviderForProject } from "./project.ts";
import { requireVersion, getVersion } from "./version.ts";
import { ingestVersionComments, type IngestResult } from "./comments.ts";

export type DriveWatchChannel = typeof driveWatchChannel.$inferSelect;

const DEFAULT_CHANNEL_TTL_MS = 24 * 60 * 60 * 1000; // 24h, well within Drive's 7-day max
const RENEW_HORIZON_MS = 60 * 60 * 1000; // renew when < 1h remaining

/**
 * Subscribe a `drive.files.watch` channel to a version's Google Doc and persist the
 * channel metadata. The webhook server (Phase 2 HTTP API) verifies inbound POSTs and
 * calls `handleDriveWatchEvent` with the channel id.
 *
 * Per SPEC §9.3 this requires a Search-Console-verified HTTPS endpoint; the URL is
 * passed in via `address`. The DB row is the source of truth — channels can drop
 * silently and we treat the polling fallback (`pollVersion*`) as the safety net.
 */
export async function subscribeVersionWatch(opts: {
  versionId: string;
  address: string;
  ttlMs?: number;
}): Promise<DriveWatchChannel> {
  const ver = await requireVersion(opts.versionId);
  const tp = await tokenProviderForProject(ver.projectId);
  const channelId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const expirationMs = Date.now() + (opts.ttlMs ?? DEFAULT_CHANNEL_TTL_MS);

  const channel = await watchFile(tp, ver.googleDocId, {
    channelId,
    address: opts.address,
    token,
    expirationMs,
  });

  const inserted = await db
    .insert(driveWatchChannel)
    .values({
      versionId: ver.id,
      channelId: channel.id,
      resourceId: channel.resourceId,
      token,
      address: opts.address,
      expiration: channel.expiration ? new Date(Number(channel.expiration)) : new Date(expirationMs),
    })
    .returning();
  return inserted[0]!;
}

/**
 * Stop a watch channel both on Google's side and locally. Idempotent — if the row's
 * already gone or Drive returns 404 we treat it as success.
 */
export async function unsubscribeVersionWatch(channelRowId: string): Promise<void> {
  const row = (
    await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.id, channelRowId))
      .limit(1)
  )[0];
  if (!row) return;

  const ver = await getVersion(row.versionId);
  if (ver) {
    const tp = await tokenProviderForProject(ver.projectId);
    await stopChannel(tp, { id: row.channelId, resourceId: row.resourceId });
  }

  await db.delete(driveWatchChannel).where(eq(driveWatchChannel.id, row.id));
}

export async function listWatchChannels(): Promise<DriveWatchChannel[]> {
  return db.select().from(driveWatchChannel).orderBy(asc(driveWatchChannel.createdAt));
}

/**
 * Inbound push handler. Drive sends `X-Goog-Channel-ID` + `X-Goog-Channel-Token` +
 * `X-Goog-Resource-State` (no body, per SPEC §9.3). We look up the channel, verify
 * the token, mark `lastEventAt`, and re-pull comments for the corresponding version.
 *
 * Resource states we care about: "update", "change". "sync" is a no-op handshake.
 * Returns null when the event is for an unknown channel (already stopped) — the HTTP
 * layer should still respond 200 OK so Google stops retrying.
 */
export async function handleDriveWatchEvent(opts: {
  channelId: string;
  channelToken?: string;
  resourceState?: string;
}): Promise<IngestResult | null> {
  const row = (
    await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.channelId, opts.channelId))
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.token && opts.channelToken !== row.token) {
    throw new Error(`channel ${opts.channelId}: token mismatch`);
  }

  await db
    .update(driveWatchChannel)
    .set({ lastEventAt: new Date() })
    .where(eq(driveWatchChannel.id, row.id));

  if (opts.resourceState === "sync") return null;

  const result = await ingestVersionComments(row.versionId);
  await db
    .update(driveWatchChannel)
    .set({ lastSyncedAt: new Date() })
    .where(eq(driveWatchChannel.id, row.id));
  return result;
}

/**
 * Polling fallback (SPEC §9.3): re-ingest comments for every active version whose row
 * is missing watch coverage or whose last sync is stale. Cheap to call on a cron — the
 * Drive `comments.list` endpoint is idempotent and `ingestVersionComments` skips rows
 * that already exist.
 */
export interface PollOutcome {
  versionId: string;
  /** Set when the per-version ingest succeeded. */
  result?: IngestResult;
  /** Set when the per-version ingest threw; the rest of the sweep still ran. */
  error?: string;
}

export async function pollAllActiveVersions(): Promise<PollOutcome[]> {
  const versions = await db
    .select()
    .from(version)
    .where(eq(version.status, "active" satisfies VersionStatus));
  const out: PollOutcome[] = [];
  for (const v of versions) {
    try {
      out.push({ versionId: v.id, result: await ingestVersionComments(v.id) });
    } catch (err) {
      // One bad version (revoked credentials, doc trashed, transient 5xx)
      // shouldn't stall the cron. Record and move on; the next sweep
      // retries.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`poll: version ${v.id} failed: ${message}`);
      out.push({ versionId: v.id, error: message });
    }
  }
  return out;
}

/**
 * Renew channels whose expiration is within RENEW_HORIZON_MS. Stops the old channel,
 * subscribes a new one with the same address, and replaces the DB row. Channels with
 * no expiration recorded are renewed unconditionally.
 */
export async function renewExpiringChannels(opts: { now?: number } = {}): Promise<{
  renewed: number;
  failed: number;
}> {
  const now = opts.now ?? Date.now();
  const horizonAt = new Date(now + RENEW_HORIZON_MS);
  const rows = await db
    .select()
    .from(driveWatchChannel)
    .where(
      or(
        isNull(driveWatchChannel.expiration),
        lt(driveWatchChannel.expiration, horizonAt),
      ),
    );

  let renewed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await unsubscribeVersionWatch(row.id);
      await subscribeVersionWatch({
        versionId: row.versionId,
        address: row.address,
      });
      renewed++;
    } catch (err) {
      failed++;
      console.error(`renew failed for channel ${row.channelId}: ${err}`);
    }
  }
  return { renewed, failed };
}

