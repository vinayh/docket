import type { CaptureInput, IngestCapturesResult, Settings } from "./types.ts";

/**
 * Typed message envelope for runtime.sendMessage / runtime.onMessage between
 * the content script (capture role) and the service worker (queue + flush).
 * Each variant has a `kind` discriminator so the SW can dispatch with
 * exhaustive switch coverage.
 */
export type Message =
  | { kind: "capture/submit"; captures: CaptureInput[] }
  | { kind: "settings/get" }
  | { kind: "settings/set"; settings: Settings }
  | { kind: "queue/flush" }
  | { kind: "queue/peek" };

export type MessageResponse =
  | { kind: "capture/submit"; queuedCount: number }
  | { kind: "settings/get"; settings: Settings | null }
  | { kind: "settings/set"; ok: true }
  | { kind: "queue/flush"; result: IngestCapturesResult | { error: string } | null }
  | { kind: "queue/peek"; queueSize: number; lastError: string | null };
