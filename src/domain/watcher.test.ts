import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  cleanDb,
  seedDriveWatchChannel,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { db } from "../db/client.ts";
import { driveWatchChannel } from "../db/schema.ts";
import {
  getDriveWatchChannel,
  getDriveWatchChannelByChannelId,
  handleDriveWatchEvent,
  pollAllActiveVersions,
  renewExpiringChannels,
} from "./watcher.ts";

beforeEach(cleanDb);

async function seedChannel(overrides: Partial<Parameters<typeof seedDriveWatchChannel>[0]> = {}) {
  const owner = await seedUser({ email: `owner-${crypto.randomUUID()}@example.com` });
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
  const ch = await seedDriveWatchChannel({ versionId: ver.id, ...overrides });
  return { owner, proj, ver, ch };
}

describe("handleDriveWatchEvent", () => {
  test("returns null for an unknown channel id (channel already stopped)", async () => {
    const result = await handleDriveWatchEvent({
      channelId: "unknown-channel",
      channelToken: "anything",
      resourceState: "update",
    });
    expect(result).toBeNull();
  });

  test("throws on token mismatch — even an attacker who learns a channel id can't trigger ingest", async () => {
    const { ch } = await seedChannel({ token: "secret-1" });
    await expect(
      handleDriveWatchEvent({
        channelId: ch.channelId,
        channelToken: "wrong-token",
        resourceState: "update",
      }),
    ).rejects.toThrow(/token mismatch/);
  });

  test("throws when the stored token is null (defense in depth)", async () => {
    const { ch } = await seedChannel({ token: null });
    await expect(
      handleDriveWatchEvent({
        channelId: ch.channelId,
        channelToken: "anything",
        resourceState: "update",
      }),
    ).rejects.toThrow(/token mismatch/);
  });

  test("sync state is a no-op handshake — bumps lastEventAt but does not call ingest", async () => {
    const { ch } = await seedChannel({ token: "secret-1" });
    const before = await getDriveWatchChannel(ch.id);
    expect(before?.lastEventAt).toBeNull();

    const result = await handleDriveWatchEvent({
      channelId: ch.channelId,
      channelToken: "secret-1",
      resourceState: "sync",
    });
    expect(result).toBeNull();

    const after = await getDriveWatchChannel(ch.id);
    expect(after?.lastEventAt).not.toBeNull();
    // sync handshake must not bump lastSyncedAt — it's reserved for ingests.
    expect(after?.lastSyncedAt?.getTime()).toBe(before?.lastSyncedAt?.getTime());
  });
});

describe("getDriveWatchChannelByChannelId", () => {
  test("looks up by Google channel id, not the local row id", async () => {
    const { ch } = await seedChannel();
    const found = await getDriveWatchChannelByChannelId(ch.channelId);
    expect(found?.id).toBe(ch.id);
  });

  test("returns null when the channel id is unknown", async () => {
    expect(await getDriveWatchChannelByChannelId("nope")).toBeNull();
  });
});

describe("pollAllActiveVersions", () => {
  test("returns an empty outcome list when there are no versions", async () => {
    const outcomes = await pollAllActiveVersions();
    expect(outcomes).toEqual([]);
  });

  test("one failing version does not stall the sweep — every version gets an outcome", async () => {
    // Three versions; none have OAuth credentials hooked up, so each call to
    // ingestVersionComments will throw. The sweep must record an outcome for
    // each rather than abort on the first error.
    const owner = await seedUser({ email: "owner-poll@example.com" });
    const proj = await seedProject({ ownerUserId: owner.id });
    const v1 = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
    const v2 = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
    const v3 = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });

    const outcomes = await pollAllActiveVersions();
    expect(outcomes).toHaveLength(3);
    const seen = new Set(outcomes.map((o) => o.versionId));
    expect(seen.has(v1.id)).toBe(true);
    expect(seen.has(v2.id)).toBe(true);
    expect(seen.has(v3.id)).toBe(true);
    // No Google credentials wired up in unit-test setup → every version reports an error
    // rather than a successful ingest result.
    for (const o of outcomes) {
      expect(o.error).toBeDefined();
      expect(o.result).toBeUndefined();
    }
  });
});

describe("renewExpiringChannels", () => {
  test("ignores channels with expiration far in the future", async () => {
    await seedChannel({ expiration: new Date(Date.now() + 86_400_000) });
    const result = await renewExpiringChannels();
    expect(result).toEqual({ renewed: 0, failed: 0 });
  });

  test("picks up channels whose expiration is within the renew horizon", async () => {
    // 30 minutes from now is well inside the 1-hour renew horizon.
    await seedChannel({ expiration: new Date(Date.now() + 30 * 60 * 1000) });
    // Renewal needs Google credentials we don't have in unit tests, so the
    // attempt itself fails — but the *selection* logic landed it in the work
    // set, which is what we're verifying.
    const result = await renewExpiringChannels();
    expect(result.renewed).toBe(0);
    expect(result.failed).toBe(1);
  });

  test("picks up channels with NULL expiration unconditionally", async () => {
    // A null expiration usually means a prior malformed parseExpiration
    // fallback; the comment in watcher.ts says we renew these to clean them up.
    await seedChannel({ expiration: null });
    const result = await renewExpiringChannels();
    expect(result.failed).toBe(1);
  });

  test("the original row stays in place when renewal fails (idempotent retry next sweep)", async () => {
    const { ch } = await seedChannel({ expiration: new Date(Date.now() + 30 * 60 * 1000) });
    await renewExpiringChannels();
    const still = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.id, ch.id))
      .limit(1);
    // The failure path doesn't run the transaction, so the old row should
    // still be present and a future sweep can retry.
    expect(still).toHaveLength(1);
  });
});
