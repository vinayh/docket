import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  cleanDb,
  seedDriveWatchChannel,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { account, driveWatchChannel, version } from "../db/schema.ts";
import {
  getDriveWatchChannel,
  getDriveWatchChannelByChannelId,
  handleDriveWatchEvent,
  pollAllActiveVersions,
  renewExpiringChannels,
  subscribeVersionWatch,
  unsubscribeVersionWatch,
} from "./watcher.ts";

beforeEach(cleanDb);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

interface DriveStubState {
  watchCalls: { fileId: string; body: { id: string; address: string; token?: string; expiration?: string } }[];
  stopCalls: { id: string; resourceId: string }[];
  /** When set, the next watch call returns this status + body instead of 200 OK. */
  watchError?: { status: number; body: string };
  /** When set, the next stop call returns this status. */
  stopError?: { status: number; body: string };
}

function stubDriveWatch(state: DriveStubState = { watchCalls: [], stopCalls: [] }): DriveStubState {
  setFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const watchM = /\/drive\/v3\/files\/([^/]+)\/watch/.exec(url);
    if (watchM && init?.method === "POST") {
      const fileId = decodeURIComponent(watchM[1]!);
      const body = JSON.parse(String(init.body)) as DriveStubState["watchCalls"][number]["body"];
      state.watchCalls.push({ fileId, body });
      if (state.watchError) {
        const err = state.watchError;
        state.watchError = undefined;
        return new Response(err.body, { status: err.status });
      }
      return new Response(
        JSON.stringify({
          kind: "api#channel",
          id: body.id,
          resourceId: `resource-for-${fileId}`,
          resourceUri: `https://example.com/${fileId}`,
          token: body.token,
          expiration: body.expiration ?? String(Date.now() + 86_400_000),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/drive/v3/channels/stop") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: string; resourceId: string };
      state.stopCalls.push(body);
      if (state.stopError) {
        const err = state.stopError;
        state.stopError = undefined;
        return new Response(err.body, { status: err.status });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return state;
}

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
    const { ch, ver } = await seedChannel({ token: "secret-1" });
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
    // sync handshake must not bump version.lastSyncedAt — it's reserved for ingests.
    const verRow = (
      await db.select().from(version).where(eq(version.id, ver.id)).limit(1)
    )[0];
    expect(verRow?.lastSyncedAt).toBeNull();
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

  test("success path: stops the old channel, inserts a new row, deletes the old row", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({
      projectId: p.id,
      createdByUserId: owner.id,
      googleDocId: "doc-for-renew-0123456789",
    });
    const oldRow = await seedDriveWatchChannel({
      versionId: v.id,
      expiration: new Date(Date.now() + 30 * 60 * 1000),
    });
    const stub = stubDriveWatch();

    const r = await renewExpiringChannels();
    expect(r.renewed).toBe(1);
    expect(r.failed).toBe(0);
    expect(stub.watchCalls).toHaveLength(1);
    expect(stub.watchCalls[0]?.fileId).toBe("doc-for-renew-0123456789");
    expect(stub.stopCalls).toHaveLength(1);
    expect(stub.stopCalls[0]?.id).toBe(oldRow.channelId);

    // Old row gone, new row in its place for the same version.
    const remaining = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.versionId, v.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(oldRow.id);
    expect(remaining[0]?.channelId).not.toBe(oldRow.channelId);
  });

  test("swallows a stop-old failure once the new channel is live (idempotent)", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const oldRow = await seedDriveWatchChannel({
      versionId: v.id,
      expiration: new Date(Date.now() + 30 * 60 * 1000),
    });
    const stub = stubDriveWatch();
    // Watch succeeds → new row inserted. The follow-up stopChannel call
    // returns 500 — the catch in replaceWatchChannel logs and returns.
    stub.stopError = { status: 500, body: "transient" };

    const r = await renewExpiringChannels();
    expect(r.renewed).toBe(1);
    expect(r.failed).toBe(0);

    // The old row is still deleted (the swap happens before the stop call).
    const same = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.id, oldRow.id));
    expect(same).toHaveLength(0);
  });
});

describe("subscribeVersionWatch", () => {
  test("happy path: posts to /watch and records the channel row", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({
      projectId: p.id,
      createdByUserId: owner.id,
      googleDocId: "doc-sub-0123456789abcdef",
    });
    const stub = stubDriveWatch();

    const row = await subscribeVersionWatch({
      versionId: v.id,
      address: "https://example.com/webhooks/drive",
    });
    expect(row.versionId).toBe(v.id);
    expect(row.address).toBe("https://example.com/webhooks/drive");
    expect(row.token?.length ?? 0).toBeGreaterThan(0);
    expect(stub.watchCalls).toHaveLength(1);
    expect(stub.watchCalls[0]?.fileId).toBe("doc-sub-0123456789abcdef");
    expect(stub.watchCalls[0]?.body.address).toBe(
      "https://example.com/webhooks/drive",
    );
  });

  test("respects a caller-supplied ttlMs", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const stub = stubDriveWatch();

    const ttlMs = 6 * 60 * 60 * 1000; // 6h
    const before = Date.now();
    await subscribeVersionWatch({
      versionId: v.id,
      address: "https://example.com/webhooks/drive",
      ttlMs,
    });
    const expirationMs = Number(stub.watchCalls[0]?.body.expiration);
    // Allow a ±5s window for the call-time arithmetic.
    expect(expirationMs).toBeGreaterThanOrEqual(before + ttlMs - 5000);
    expect(expirationMs).toBeLessThanOrEqual(before + ttlMs + 5000);
  });

  test("propagates Drive failure — caller's create flow surfaces it", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const stub = stubDriveWatch();
    stub.watchError = { status: 403, body: "drive.file scope required" };

    await expect(
      subscribeVersionWatch({
        versionId: v.id,
        address: "https://example.com/webhooks/drive",
      }),
    ).rejects.toThrow(/403/);
    // No DB row inserted on failure.
    const rows = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.versionId, v.id));
    expect(rows).toHaveLength(0);
  });
});

describe("unsubscribeVersionWatch", () => {
  test("no-op when the channel row doesn't exist (idempotent)", async () => {
    // No stub → fetch would throw. The function must short-circuit before any
    // Drive call when the row is missing.
    setFetch(async () => {
      throw new Error("must not call fetch when row is missing");
    });
    await expect(unsubscribeVersionWatch(crypto.randomUUID())).resolves.toBeUndefined();
  });

  test("happy path: calls stopChannel and deletes the row", async () => {
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const row = await seedDriveWatchChannel({ versionId: v.id });
    const stub = stubDriveWatch();

    await unsubscribeVersionWatch(row.id);
    expect(stub.stopCalls).toHaveLength(1);
    expect(stub.stopCalls[0]?.id).toBe(row.channelId);
    expect(stub.stopCalls[0]?.resourceId).toBe(row.resourceId);

    const rows = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.id, row.id));
    expect(rows).toHaveLength(0);
  });

  test("skips Drive call when the version is gone but still deletes the row", async () => {
    // Build a row, then delete the version it points at. The function should
    // notice the missing version and skip the stopChannel call entirely.
    const owner = await seedUser();
    await seedDriveCredential(owner.id);
    const p = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const row = await seedDriveWatchChannel({ versionId: v.id });

    // Disable FKs so we can delete the version while the channel row points
    // at it (real FK would CASCADE; we want the stranded-row case).
    db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.delete(version).where(eq(version.id, v.id));
    db.run(sql`PRAGMA foreign_keys = ON`);

    setFetch(async () => {
      throw new Error("must not call fetch when version is missing");
    });
    await unsubscribeVersionWatch(row.id);

    const rows = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.id, row.id));
    expect(rows).toHaveLength(0);
  });
});
