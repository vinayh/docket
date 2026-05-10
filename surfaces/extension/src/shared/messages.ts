import type {
  CaptureInput,
  DocState,
  IngestCapturesResult,
  PickerConfig,
  RegisterDocResult,
  Settings,
} from "./types.ts";

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
  | { kind: "queue/peek" }
  | { kind: "doc/state"; docId: string }
  | { kind: "doc/sync"; docId: string }
  | { kind: "doc/register"; docUrlOrId: string }
  | { kind: "picker/config" };

/**
 * Each response carries the same `kind` as its request so callers can route
 * cleanly. `error` is optional on every variant: if set, treat the rest of
 * the fields as undefined/unreliable. Pre-fix, the listener fell back to a
 * `kind: "queue/peek"` shape on every error regardless of the original
 * kind, which mis-routed errors for `settings/set` and `capture/submit`.
 */
export type MessageResponse =
  | { kind: "capture/submit"; queuedCount: number; error?: string }
  | { kind: "settings/get"; settings: Settings | null; error?: string }
  | { kind: "settings/set"; ok: true; error?: string }
  | {
      kind: "queue/flush";
      result: IngestCapturesResult | { error: string } | null;
      error?: string;
    }
  | { kind: "queue/peek"; queueSize: number; lastError: string | null; error?: string }
  | { kind: "doc/state"; state: DocState | null; error?: string }
  | { kind: "doc/sync"; state: DocState | null; error?: string }
  | { kind: "doc/register"; result: RegisterDocResult; error?: string }
  | { kind: "picker/config"; config: PickerConfig | null; error?: string };
