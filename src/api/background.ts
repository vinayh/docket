import { config } from "../config.ts";
import { pollAllActiveVersions, renewExpiringChannels } from "../domain/watcher.ts";

/**
 * In-process renew + polling loops (SPEC §9.3). Both gate on
 * `MARGIN_PUBLIC_BASE_URL`: there's nothing to renew if no production
 * webhook address has been configured, and the polling fallback is just
 * paired infrastructure for the same setup.
 *
 * Loops use a self-rescheduling `setTimeout` chain (not `setInterval`), so a
 * slow run can't overlap with the next tick — the next timer is armed only
 * after the previous run finishes. This matters because `pollAllActiveVersions`
 * iterates every active version serially through Drive; a backlog plus
 * concurrent ingests would compound the upsert races the unique constraints
 * guard against.
 */

const RENEW_INTERVAL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;

export interface BackgroundLoops {
  stop(): void;
}

export function startBackgroundLoops(): BackgroundLoops {
  if (!config.publicBaseUrl) {
    console.log("background loops: MARGIN_PUBLIC_BASE_URL not set, skipping");
    return { stop() {} };
  }

  console.log(
    `background loops: renew every ${RENEW_INTERVAL_MS / 60000}m, poll every ${POLL_INTERVAL_MS / 60000}m`,
  );

  let stopped = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRenew = (delay: number) => {
    if (stopped) return;
    renewTimer = setTimeout(async () => {
      try {
        const r = await renewExpiringChannels();
        if (r.renewed > 0 || r.failed > 0) {
          console.log(`renew: renewed=${r.renewed} failed=${r.failed}`);
        }
      } catch (err) {
        console.error("renew loop error:", err);
      } finally {
        scheduleRenew(RENEW_INTERVAL_MS);
      }
    }, delay);
  };

  const schedulePoll = (delay: number) => {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      try {
        const outcomes = await pollAllActiveVersions();
        const ok = outcomes.filter((o) => !o.error).length;
        const errs = outcomes.length - ok;
        if (outcomes.length > 0) {
          console.log(`poll: versions=${outcomes.length} ok=${ok} errors=${errs}`);
        }
        for (const o of outcomes) {
          if (o.error) console.error(`poll: version ${o.versionId} failed: ${o.error}`);
        }
      } catch (err) {
        console.error("poll loop error:", err);
      } finally {
        schedulePoll(POLL_INTERVAL_MS);
      }
    }, delay);
  };

  scheduleRenew(RENEW_INTERVAL_MS);
  schedulePoll(POLL_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      if (renewTimer) clearTimeout(renewTimer);
      if (pollTimer) clearTimeout(pollTimer);
    },
  };
}
