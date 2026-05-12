import type {
  CommentActionKind,
  CommentActionResult,
  DocState,
  PickerConfig,
  ProjectDetail,
  ProjectSettingsView,
  RegisterDocResult,
  Settings,
  VersionCommentsPayload,
  VersionDiffPayload,
} from "./types.ts";

/**
 * Typed message envelope for runtime.sendMessage / runtime.onMessage between
 * the popup / side-panel and the service worker. Each variant has a `kind`
 * discriminator so the SW dispatches with exhaustive switch coverage.
 *
 * Pre-docx-ingest this also carried `capture/submit`, `queue/flush`, and
 * `queue/peek` for the content-script → SW → backend pipeline. The
 * docx-export ingest (SPEC §9.8) runs server-side, so those kinds are gone.
 */
export type Message =
  | { kind: "settings/get" }
  | { kind: "settings/set"; settings: Settings }
  | { kind: "auth/sign-in"; backendUrl: string }
  | { kind: "auth/sign-out" }
  | { kind: "doc/state"; docId: string }
  | { kind: "doc/sync"; docId: string }
  | { kind: "doc/register"; docUrlOrId: string }
  | { kind: "picker/config" }
  | { kind: "project/detail"; projectId: string }
  | { kind: "version/diff"; fromVersionId: string; toVersionId: string }
  | { kind: "version/comments"; versionId: string }
  | {
      kind: "comment/action";
      canonicalCommentId: string;
      action: CommentActionKind;
      targetVersionId?: string;
    }
  | { kind: "settings/load"; projectId: string }
  | {
      kind: "settings/update";
      projectId: string;
      patch: Partial<ProjectSettingsView>;
    };

/**
 * Each response carries the same `kind` as its request so callers can route
 * cleanly. `error` is optional on every variant: if set, treat the rest of
 * the fields as undefined/unreliable.
 */
export type MessageResponse =
  | { kind: "settings/get"; settings: Settings | null; error?: string }
  | { kind: "settings/set"; ok: true; error?: string }
  | { kind: "auth/sign-in"; ok: boolean; error?: string }
  | { kind: "auth/sign-out"; ok: true; error?: string }
  | { kind: "doc/state"; state: DocState | null; error?: string }
  | { kind: "doc/sync"; state: DocState | null; error?: string }
  | { kind: "doc/register"; result: RegisterDocResult; error?: string }
  | { kind: "picker/config"; config: PickerConfig | null; error?: string }
  | { kind: "project/detail"; detail: ProjectDetail | null; error?: string }
  | { kind: "version/diff"; payload: VersionDiffPayload | null; error?: string }
  | {
      kind: "version/comments";
      payload: VersionCommentsPayload | null;
      error?: string;
    }
  | {
      kind: "comment/action";
      result: CommentActionResult | null;
      error?: string;
    }
  | {
      kind: "settings/load";
      settings: ProjectSettingsView | null;
      error?: string;
    }
  | {
      kind: "settings/update";
      settings: ProjectSettingsView | null;
      error?: string;
    };
