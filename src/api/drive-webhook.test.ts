import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { db } from "../db/client.ts";
import { driveWatchChannel } from "../db/schema.ts";
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
    // sync only stamps lastEventAt, not lastSyncedAt — the comments fetch
    // is skipped so we never reach the second update branch.
    expect(row[0]?.lastEventAt).toBeInstanceOf(Date);
    expect(row[0]?.lastSyncedAt).toBeNull();
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
