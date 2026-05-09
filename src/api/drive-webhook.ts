import { handleDriveWatchEvent } from "../domain/watcher.ts";

/**
 * Drive `files.watch` push receiver. Google posts an empty body with state in
 * the `X-Goog-*` headers (SPEC §9.3); we always respond 200 OK so Google
 * stops retrying — channel-level errors are logged for the operator.
 */
export async function handleDriveWebhook(req: Request): Promise<Response> {
  const channelId = req.headers.get("x-goog-channel-id");
  const resourceState = req.headers.get("x-goog-resource-state") ?? undefined;
  const channelToken = req.headers.get("x-goog-channel-token") ?? undefined;

  if (!channelId) {
    return new Response("missing X-Goog-Channel-ID", { status: 400 });
  }

  try {
    await handleDriveWatchEvent({ channelId, channelToken, resourceState });
  } catch (err) {
    console.error(`drive webhook error for channel ${channelId}: ${err}`);
  }
  return new Response(null, { status: 200 });
}
