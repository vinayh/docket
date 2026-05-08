import { parseArgs } from "node:util";
import {
  handleDriveWatchEvent,
  listWatchChannels,
  pollAllActiveVersions,
  renewExpiringChannels,
  subscribeVersionWatch,
  unsubscribeVersionWatch,
} from "../domain/watcher.ts";
import { die } from "./util.ts";

const USAGE = `\
usage:
  bun docket watcher subscribe <version-id> --address <https-url> [--ttl-ms <n>]
  bun docket watcher list
  bun docket watcher unsubscribe <channel-row-id>
  bun docket watcher renew
  bun docket watcher poll
  bun docket watcher simulate <channel-id> [--state update] [--token <t>]

Per SPEC §9.3 the address must be an HTTPS endpoint with a domain verified in
Google Search Console. The Phase-2 HTTP API will own that endpoint; for now
\`simulate\` lets you exercise the handler locally.`;

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub) die(USAGE);

  if (sub === "subscribe") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        address: { type: "string" },
        "ttl-ms": { type: "string" },
      },
      allowPositionals: true,
    });
    const versionId = positionals[0];
    if (!versionId || !values.address) die(USAGE);
    const ttlMs = values["ttl-ms"] ? Number(values["ttl-ms"]) : undefined;

    const ch = await subscribeVersionWatch({
      versionId,
      address: values.address,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    console.log(`✓ subscribed channel ${ch.channelId}`);
    console.log(`  resource_id: ${ch.resourceId}`);
    console.log(`  expires: ${ch.expiration?.toISOString() ?? "(none)"}`);
    return;
  }

  if (sub === "list") {
    const channels = await listWatchChannels();
    if (channels.length === 0) {
      console.log("no active channels.");
      return;
    }
    for (const c of channels) {
      const exp = c.expiration ? c.expiration.toISOString() : "—";
      const last = c.lastSyncedAt ? c.lastSyncedAt.toISOString() : "—";
      console.log(
        `${c.id}  version=${c.versionId.slice(0, 8)}  channel=${c.channelId.slice(0, 8)}  exp=${exp}  last_sync=${last}`,
      );
    }
    return;
  }

  if (sub === "unsubscribe") {
    const channelRowId = rest[0];
    if (!channelRowId) die(USAGE);
    await unsubscribeVersionWatch(channelRowId);
    console.log(`✓ unsubscribed channel row ${channelRowId}`);
    return;
  }

  if (sub === "renew") {
    const r = await renewExpiringChannels();
    console.log(`✓ renew sweep: renewed=${r.renewed} failed=${r.failed}`);
    return;
  }

  if (sub === "poll") {
    const results = await pollAllActiveVersions();
    if (results.length === 0) {
      console.log("no active versions.");
      return;
    }
    for (const r of results) {
      console.log(
        `version=${r.versionId.slice(0, 8)}  fetched=${r.fetched}  inserted=${r.inserted}  already=${r.alreadyPresent}  skipped=${r.skipped}`,
      );
    }
    return;
  }

  if (sub === "simulate") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        state: { type: "string" },
        token: { type: "string" },
      },
      allowPositionals: true,
    });
    const channelId = positionals[0];
    if (!channelId) die(USAGE);
    const r = await handleDriveWatchEvent({
      channelId,
      ...(values.token !== undefined ? { channelToken: values.token } : {}),
      resourceState: values.state ?? "update",
    });
    if (!r) {
      console.log("no-op (sync event or unknown channel).");
      return;
    }
    console.log(
      `✓ event handled: fetched=${r.fetched} inserted=${r.inserted} already=${r.alreadyPresent} skipped=${r.skipped}`,
    );
    return;
  }

  die(USAGE);
}
