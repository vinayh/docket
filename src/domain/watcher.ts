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

// new Date(NaN) → NULL in Drizzle → row matches isNull and gets renewed every sweep. Guard against it.
function parseExpiration(raw: string | undefined, fallbackMs: number): Date {
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return new Date(n);
  }
  return new Date(fallbackMs);
}

// address must be a Search-Console-verified HTTPS endpoint (SPEC §9.3). Polling is the safety net.
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

export async function getDriveWatchChannel(id: string): Promise<DriveWatchChannel | null> {
  const rows = await db
    .select()
    .from(driveWatchChannel)
    .where(eq(driveWatchChannel.id, id))
    .limit(1);
  return rows[0] ?? null;
}

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

// Idempotent: missing row or 404 from Drive both treat as success.
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
 * Inbound push handler. Returns null for unknown channels and for `resourceState === "sync"`
 * (handshake). The HTTP layer should still respond 200 in those cases so Google stops retrying.
 */
export async function handleDriveWatchEvent(opts: {
  channelId: string;
  channelToken?: string;
  resourceState?: string;
}): Promise<IngestResult | null> {
  const row = await getDriveWatchChannelByChannelId(opts.channelId);
  if (!row) return null;
  // Defense in depth: refuse when token is null (manual seeding, future migration) so an
  // attacker who learns a channel id can't trigger ingests.
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

// Polling fallback (SPEC §9.3). Idempotent; safe to run on a cron.
export interface PollOutcome {
  versionId: string;
  result?: IngestResult;
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
      // One bad version shouldn't stall the cron; record and continue.
      const message = err instanceof Error ? err.message : String(err);
      out.push({ versionId: v.id, error: message });
    }
  }
  return out;
}

/**
 * Renew channels expiring within RENEW_HORIZON_MS. Row swap (delete-old + insert-new) is
 * atomic so a crash between insert and delete can't leave both rows expiring and double the
 * channel count on the next sweep. Channels with null expiration are renewed unconditionally.
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

  // If the DB swap fails after watchFile succeeded, the new channel is live on Google's side
  // with no row tracking it — best-effort stop it so we don't get orphaned webhook fanout.
  try {
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
  } catch (err) {
    await stopChannel(tp, { id: channel.id, resourceId: channel.resourceId }).catch((stopErr) => {
      const msg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      console.warn(
        `renew: failed to stop orphan new channel ${channel.id} after DB swap failure: ${msg}`,
      );
    });
    throw err;
  }

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

