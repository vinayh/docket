import { parseArgs } from "node:util";
import {
  handleDriveWatchEvent,
  listWatchChannels,
  pollAllActiveVersions,
  renewExpiringChannels,
  subscribeVersionWatch,
  unsubscribeVersionWatch,
} from "../domain/watcher.ts";
import { usage, dispatchSubcommands } from "./util.ts";

const USAGE = `\
usage:
  bun margin watcher subscribe <version-id> --address <https-url> [--ttl-ms <n>]
  bun margin watcher list
  bun margin watcher unsubscribe <channel-row-id>
  bun margin watcher renew
  bun margin watcher poll
  bun margin watcher simulate <channel-id> [--state update] [--token <t>]

Per SPEC §9.3 the address must be an HTTPS endpoint with a domain verified in
Google Search Console. The Phase-2 HTTP API will own that endpoint; for now
\`simulate\` lets you exercise the handler locally.`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    subscribe: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          address: { type: "string" },
          "ttl-ms": { type: "string" },
        },
        allowPositionals: true,
      });
      const versionId = positionals[0];
      if (!versionId || !values.address) usage(USAGE);
      const ttlMs = values["ttl-ms"] ? Number(values["ttl-ms"]) : undefined;

      const ch = await subscribeVersionWatch({
        versionId,
        address: values.address,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      console.log(`✓ subscribed channel ${ch.channelId}`);
      console.log(`  resource_id: ${ch.resourceId}`);
      console.log(`  expires: ${ch.expiration?.toISOString() ?? "(none)"}`);
    },

    list: async () => {
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
    },

    unsubscribe: async ([channelRowId]) => {
      if (!channelRowId) usage(USAGE);
      await unsubscribeVersionWatch(channelRowId);
      console.log(`✓ unsubscribed channel row ${channelRowId}`);
    },

    renew: async () => {
      const r = await renewExpiringChannels();
      console.log(`✓ renew sweep: renewed=${r.renewed} failed=${r.failed}`);
    },

    poll: async () => {
      const outcomes = await pollAllActiveVersions();
      if (outcomes.length === 0) {
        console.log("no active versions.");
        return;
      }
      for (const o of outcomes) {
        const id = o.versionId.slice(0, 8);
        if (o.error) {
          console.log(`version=${id}  ERROR  ${o.error}`);
          continue;
        }
        const r = o.result!;
        console.log(
          `version=${id}  fetched=${r.fetched}  inserted=${r.inserted}  already=${r.alreadyPresent}  skipped_orphan_metadata=${r.skippedOrphanMetadata}`,
        );
      }
    },

    simulate: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          state: { type: "string" },
          token: { type: "string" },
        },
        allowPositionals: true,
      });
      const channelId = positionals[0];
      if (!channelId) usage(USAGE);
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
        `✓ event handled: fetched=${r.fetched} inserted=${r.inserted} already=${r.alreadyPresent} skipped_orphan_metadata=${r.skippedOrphanMetadata}`,
      );
    },
  });
