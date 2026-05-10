import type {
  CaptureInput,
  DocState,
  IngestCapturesResult,
  PickerConfig,
  ProjectDetail,
  RegisterDocResult,
  Settings,
  VersionDiffPayload,
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
  | { kind: "picker/config" }
  | { kind: "project/detail"; projectId: string }
  | { kind: "version/diff"; fromVersionId: string; toVersionId: string };

/**
 * Each response carries the same `kind` as its request so callers can route
 * cleanly. `error` is optional on every variant: if set, treat the rest of
 * the fields as undefined/unreliable.
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
  | { kind: "picker/config"; config: PickerConfig | null; error?: string }
  | { kind: "project/detail"; detail: ProjectDetail | null; error?: string }
  | { kind: "version/diff"; payload: VersionDiffPayload | null; error?: string };
