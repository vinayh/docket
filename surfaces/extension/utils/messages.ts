import * as v from "valibot";
import type {
  CommentActionResult,
  DocState,
  ProjectDetail,
  ProjectListEntry,
  ProjectSettingsView,
  RegisterDocResult,
  ReviewRequestResult,
  Settings,
  VersionCommentsPayload,
  VersionCreateResult,
  VersionDiffPayload,
} from "./types.ts";

const MAX_ID_LEN = 200;
const MAX_URL_LEN = 4 * 1024;
const MAX_FIELD_LEN = 256;
const MAX_REVIEWERS = 64;

const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN));

const CommentActionKindSchema = v.picklist([
  "accept_projection",
  "reanchor",
  "mark_resolved",
  "mark_wontfix",
  "reopen",
]);

// Patch shape mirrors the backend's ProjectSettingsPatchSchema. Lenient at the
// SW boundary (the backend re-validates with the canonical schema) — the goal
// here is to reject obviously malformed inbound messages, not to re-litigate
// email syntax.
const SettingsPatchSchema = v.partial(
  v.object({
    notifyOnComment: v.boolean(),
    notifyOnReviewComplete: v.boolean(),
    defaultReviewerEmails: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN))),
      v.maxLength(MAX_REVIEWERS),
    ),
    defaultOverlayId: v.nullable(v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN))),
    slackWorkspaceRef: v.nullable(v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN))),
  }),
);

const SettingsSchema = v.object({
  backendUrl: v.pipe(v.string(), v.maxLength(MAX_URL_LEN)),
  sessionToken: v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN * 4)),
});

/**
 * Inbound-message envelope for `runtime.sendMessage` between popup/side-panel
 * and the SW. Used as both the runtime guard (`v.safeParse`) on inbound calls
 * and the source-of-truth for the static `Message` type — so a new variant
 * can't be added on one side without the other.
 *
 * Pre-docx-ingest this also carried `capture/submit`, `queue/flush`, and
 * `queue/peek` for the content-script → SW → backend pipeline. Server-side
 * ingest (SPEC §9.8) made those unnecessary.
 */
export const MessageSchema = v.variant("kind", [
  v.object({ kind: v.literal("settings/get") }),
  v.object({ kind: v.literal("settings/set"), settings: SettingsSchema }),
  v.object({ kind: v.literal("auth/sign-out") }),
  v.object({ kind: v.literal("doc/state"), docId: Id }),
  v.object({ kind: v.literal("doc/sync"), docId: Id }),
  v.object({
    kind: v.literal("doc/register"),
    docUrlOrId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_URL_LEN)),
  }),
  v.object({ kind: v.literal("project/detail"), projectId: Id }),
  v.object({ kind: v.literal("projects/list") }),
  v.object({
    kind: v.literal("version/create"),
    projectId: Id,
    label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  }),
  v.object({
    kind: v.literal("version/diff"),
    fromVersionId: Id,
    toVersionId: Id,
  }),
  v.object({ kind: v.literal("version/comments"), versionId: Id }),
  v.object({
    kind: v.literal("comment/action"),
    canonicalCommentId: Id,
    action: CommentActionKindSchema,
    targetVersionId: v.optional(Id),
  }),
  v.object({ kind: v.literal("settings/load"), projectId: Id }),
  v.object({
    kind: v.literal("settings/update"),
    projectId: Id,
    patch: SettingsPatchSchema,
  }),
  v.object({
    kind: v.literal("review/request"),
    versionId: Id,
    assigneeEmails: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN))),
      v.minLength(1),
      v.maxLength(MAX_REVIEWERS),
    ),
    deadline: v.optional(v.union([v.null(), v.pipe(v.number(), v.integer())])),
  }),
]);

export type Message = v.InferOutput<typeof MessageSchema>;

/**
 * Each response carries the same `kind` as its request so callers can route
 * cleanly. `error` is optional on every variant: if set, treat the rest of
 * the fields as undefined/unreliable.
 *
 * Responses originate inside the SW and aren't schema-validated — they're
 * trusted by construction.
 */
export type MessageResponse =
  | {
      kind: "settings/get";
      settings: Settings | null;
      /**
       * The persisted backend URL, returned even when `settings` is null
       * because the user has saved a backend URL but not yet signed in.
       * The popup uses this to distinguish "needs Open Options" from
       * "needs sign-in" without a second round-trip.
       */
      backendUrl: string | null;
      error?: string;
    }
  | { kind: "settings/set"; ok: true; error?: string }
  | { kind: "auth/sign-out"; ok: true; error?: string }
  | { kind: "doc/state"; state: DocState | null; error?: string }
  | { kind: "doc/sync"; state: DocState | null; error?: string }
  | { kind: "doc/register"; result: RegisterDocResult; error?: string }
  | { kind: "project/detail"; detail: ProjectDetail | null; error?: string }
  | {
      kind: "projects/list";
      projects: ProjectListEntry[] | null;
      error?: string;
    }
  | {
      kind: "version/create";
      result: VersionCreateResult | null;
      error?: string;
    }
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
    }
  | {
      kind: "review/request";
      result: ReviewRequestResult | null;
      error?: string;
    };
