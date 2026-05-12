import { asc, eq, lt, or, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  driveWatchChannel,
  version,
  type VersionStatus,
} from "../db/schema.ts";
import { stopChannel, watchFile, type WatchChannel } from "../google/drive.ts";
import { tokenProviderForProject } from "./project.ts";
import { requireVersion, getVersion } from "./version.ts";
import { ingestVersionComments, type IngestResult } from "./comments.ts";

export type DriveWatchChannel = typeof driveWatchChannel.$inferSelect;

const DEFAULT_CHANNEL_TTL_MS = 24 * 60 * 60 * 1000; // 24h, well within Drive's 7-day max
const RENEW_HORIZON_MS = 60 * 60 * 1000; // renew when < 1h remaining

/**
 * Drive returns `expiration` as a string of ms-since-epoch. A malformed
 * value would silently become `new Date(NaN)`, which Drizzle persists as
 * NULL — and then the renewer's `isNull(expiration)` clause picks the row
 * up every sweep, looping forever. Fall back to our own deadline when the
 * incoming value isn't a finite number.
 */
function parseExpiration(raw: string | undefined, fallbackMs: number): Date {
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return new Date(n);
  }
  return new Date(fallbackMs);
}

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
      expiration: parseExpiration(channel.expiration, expirationMs),
    })
    .returning();
  return inserted[0]!;
}

/** Look up a Drive watch channel row by its primary key; nullable on miss. */
export async function getDriveWatchChannel(id: string): Promise<DriveWatchChannel | null> {
  const rows = await db
    .select()
    .from(driveWatchChannel)
    .where(eq(driveWatchChannel.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Look up a Drive watch channel row by its Google channel id; nullable on miss. */
export async function getDriveWatchChannelByChannelId(
  channelId: string,
): Promise<DriveWatchChannel | null> {
  const rows = await db
    .select()
    .from(driveWatchChannel)
    .where(eq(driveWatchChannel.channelId, channelId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stop a watch channel both on Google's side and locally. Idempotent — if the row's
 * already gone or Drive returns 404 we treat it as success.
 */
export async function unsubscribeVersionWatch(channelRowId: string): Promise<void> {
  const row = await getDriveWatchChannel(channelRowId);
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
  const row = await getDriveWatchChannelByChannelId(opts.channelId);
  if (!row) return null;
  // The token is always set when `subscribeVersionWatch` creates the row.
  // Defense in depth: refuse the event if the column is null for any reason
  // (manual seeding, future migration, etc.) rather than allowing an
  // attacker who learns a channel id to trigger ingests freely.
  if (!row.token || opts.channelToken !== row.token) {
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
      // retries. The callsite logs per-version failures off `error`.
      const message = err instanceof Error ? err.message : String(err);
      out.push({ versionId: v.id, error: message });
    }
  }
  return out;
}

/**
 * Renew channels whose expiration is within RENEW_HORIZON_MS. For each
 * expiring row:
 *  1. Subscribe a fresh channel on Google (network side-effect, can't roll back).
 *  2. In a single DB transaction: delete the old row and insert the new one.
 *  3. Best-effort stop the old channel on Google.
 *
 * Folding the row swap into one transaction matters because the renew sweep
 * runs on a timer: if step (2) crashed between an `insert(new)` and a
 * `delete(old)`, the next sweep would find *both* rows expiring and renew
 * each independently, multiplying channels every cycle. With the swap atomic,
 * a crash between (1) and (2) leaves an orphan channel on Google (it'll fire
 * webhooks for an unknown channelId until its own expiration; ingest is
 * idempotent) but the DB row count stays bounded.
 *
 * Channels with no expiration recorded are renewed unconditionally — that
 * usually indicates a prior malformed `parseExpiration` fallback we want to
 * clean up.
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
      await replaceWatchChannel(row);
      renewed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`renew failed for channel ${row.channelId}: ${msg}`);
    }
  }
  return { renewed, failed };
}

async function replaceWatchChannel(oldRow: DriveWatchChannel): Promise<void> {
  const ver = await requireVersion(oldRow.versionId);
  const tp = await tokenProviderForProject(ver.projectId);

  const newChannelId = crypto.randomUUID();
  const newToken = crypto.randomUUID();
  const expirationMs = Date.now() + DEFAULT_CHANNEL_TTL_MS;
  const channel: WatchChannel = await watchFile(tp, ver.googleDocId, {
    channelId: newChannelId,
    address: oldRow.address,
    token: newToken,
    expirationMs,
  });

  db.transaction((tx) => {
    tx.delete(driveWatchChannel).where(eq(driveWatchChannel.id, oldRow.id)).run();
    tx.insert(driveWatchChannel)
      .values({
        versionId: oldRow.versionId,
        channelId: channel.id,
        resourceId: channel.resourceId,
        token: newToken,
        address: oldRow.address,
        expiration: parseExpiration(channel.expiration, expirationMs),
      })
      .run();
  });

  // Best-effort stop the old channel; Google idempotently 200/404s repeats.
  try {
    await stopChannel(tp, { id: oldRow.channelId, resourceId: oldRow.resourceId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `renew: stop-old failed for channel ${oldRow.channelId} (new channel is live): ${msg}`,
    );
  }
}

