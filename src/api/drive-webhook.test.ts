import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { db } from "../db/client.ts";
import { driveWatchChannel, version } from "../db/schema.ts";
import { handleDriveWebhook } from "./drive-webhook.ts";

beforeEach(cleanDb);

function webhookRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost/webhooks/drive", {
    method: "POST",
    headers,
  });
}

describe("/webhooks/drive", () => {
  test("400 when X-Goog-Channel-ID is missing", async () => {
    const res = await handleDriveWebhook(
      webhookRequest({ "x-goog-resource-state": "update" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("X-Goog-Channel-ID");
  });

  test("200 for an unknown channel id (Google must stop retrying)", async () => {
    const res = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": crypto.randomUUID(),
        "x-goog-resource-state": "update",
      }),
    );
    expect(res.status).toBe(200);
  });

  test('200 on resource_state="sync" is a no-op handshake (no lastSyncedAt bump)', async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const channelId = crypto.randomUUID();
    const channelToken = "sync-token";
    await db.insert(driveWatchChannel).values({
      versionId: v.id,
      channelId,
      resourceId: "res-1",
      address: "https://example.com/webhooks/drive",
      token: channelToken,
    });

    const res = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "sync",
      }),
    );
    expect(res.status).toBe(200);

    const row = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.channelId, channelId))
      .limit(1);
    // sync only stamps lastEventAt — the comments fetch is skipped, so the
    // version's lastSyncedAt (stamped at the tail of ingest) stays null.
    expect(row[0]?.lastEventAt).toBeInstanceOf(Date);
    const verRow = (
      await db.select().from(version).where(eq(version.id, v.id)).limit(1)
    )[0];
    expect(verRow?.lastSyncedAt).toBeNull();
  });

  test("200 even when the inner ingest throws (response is fire-and-forget)", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const channelId = crypto.randomUUID();
    const channelToken = "update-token";
    await db.insert(driveWatchChannel).values({
      versionId: v.id,
      channelId,
      resourceId: "res-1",
      address: "https://example.com/webhooks/drive",
      token: channelToken,
    });

    // resource_state="update" routes into ingestVersionComments → tokenProvider
    // refresh, which has no `account` row → throws. Webhook still 200s.
    const res = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "update",
      }),
    );
    expect(res.status).toBe(200);
  });

  test("repeated POSTs with the same (channelId, messageNumber) dedupe — second call short-circuits", async () => {
    // Drive retries push events from multiple regions; the dedup set keeps
    // the same logical event from running ingest twice. We can't directly
    // inspect that ingest was skipped (the domain layer would throw because
    // there's no Google credential), but we *can* observe lastEventAt: a
    // fresh event stamps it; a deduped event must not.
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const channelId = crypto.randomUUID();
    const channelToken = "tok";
    await db.insert(driveWatchChannel).values({
      versionId: v.id,
      channelId,
      resourceId: "res-1",
      address: "https://example.com/webhooks/drive",
      token: channelToken,
    });

    // First POST: resourceState=sync so the channel-token check passes and
    // the handler stamps lastEventAt without trying to ingest. Even though
    // sync is a no-op for ingest, the dedup set still records the
    // (channelId, messageNumber) key on the way through — we then revisit
    // with the SAME number and expect a 200 with no further side effects.
    const messageNumber = "42";
    const first = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "sync",
        "x-goog-message-number": messageNumber,
      }),
    );
    expect(first.status).toBe(200);
    const after1 = (
      await db
        .select()
        .from(driveWatchChannel)
        .where(eq(driveWatchChannel.channelId, channelId))
    )[0];
    expect(after1?.lastEventAt).toBeInstanceOf(Date);
    const firstStamp = after1!.lastEventAt!.getTime();

    // Wait a tick to make a re-stamp observable on fast hardware.
    await new Promise((r) => setTimeout(r, 5));

    // Second POST with the same channelId + messageNumber: dedup short-
    // circuits to 200 without invoking handleDriveWatchEvent — lastEventAt
    // must be unchanged.
    const second = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "sync",
        "x-goog-message-number": messageNumber,
      }),
    );
    expect(second.status).toBe(200);
    const after2 = (
      await db
        .select()
        .from(driveWatchChannel)
        .where(eq(driveWatchChannel.channelId, channelId))
    )[0];
    expect(after2?.lastEventAt?.getTime()).toBe(firstStamp);
  });

  test("missing X-Goog-Message-Number bypasses dedup (envelope-shape safety net)", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const channelId = crypto.randomUUID();
    const channelToken = "tok2";
    await db.insert(driveWatchChannel).values({
      versionId: v.id,
      channelId,
      resourceId: "res-1",
      address: "https://example.com/webhooks/drive",
      token: channelToken,
    });

    const first = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "sync",
      }),
    );
    expect(first.status).toBe(200);
    const after1 = (
      await db
        .select()
        .from(driveWatchChannel)
        .where(eq(driveWatchChannel.channelId, channelId))
    )[0];
    const firstStamp = after1!.lastEventAt!.getTime();

    await new Promise((r) => setTimeout(r, 5));

    // Without a message number, dedup cannot key the event — the handler
    // runs again and re-stamps lastEventAt. One redundant ingest is the
    // documented cost of preserving safety against an envelope change.
    const second = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": channelToken,
        "x-goog-resource-state": "sync",
      }),
    );
    expect(second.status).toBe(200);
    const after2 = (
      await db
        .select()
        .from(driveWatchChannel)
        .where(eq(driveWatchChannel.channelId, channelId))
    )[0];
    expect(after2!.lastEventAt!.getTime()).toBeGreaterThan(firstStamp);
  });

  test("200 + no side effects when channel-token doesn't match", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    const channelId = crypto.randomUUID();
    await db.insert(driveWatchChannel).values({
      versionId: v.id,
      channelId,
      resourceId: "res-1",
      address: "https://example.com/webhooks/drive",
      token: "real-secret",
    });

    // Wrong token — the channel-token check throws in the domain layer; the
    // webhook layer swallows it, returns 200, and the channel row stays
    // pristine (no lastEventAt stamp).
    const res = await handleDriveWebhook(
      webhookRequest({
        "x-goog-channel-id": channelId,
        "x-goog-channel-token": "wrong-secret",
        "x-goog-resource-state": "update",
      }),
    );
    expect(res.status).toBe(200);

    const row = await db
      .select()
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.channelId, channelId))
      .limit(1);
    expect(row[0]?.lastEventAt).toBeNull();
  });
});
