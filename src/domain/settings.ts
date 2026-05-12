import { eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../db/client.ts";
import { auditLog, project, type ProjectSettings } from "../db/schema.ts";
import { getOwnedProject } from "./project.ts";

/**
 * Settings surface (SPEC §12 Phase 4). Backs the side-panel "Settings" view.
 * Project settings live as a JSON blob on `project.settings` so adding a
 * field is a schema-free change. Anything the UI hasn't touched falls back
 * to a baseline default — callers should always read through
 * `loadProjectSettings`, never the raw row.
 */
export interface ProjectSettingsView {
  notifyOnComment: boolean;
  notifyOnReviewComplete: boolean;
  defaultReviewerEmails: string[];
  defaultOverlayId: string | null;
  slackWorkspaceRef: string | null;
}

const DEFAULTS: ProjectSettingsView = {
  notifyOnComment: true,
  notifyOnReviewComplete: true,
  defaultReviewerEmails: [],
  defaultOverlayId: null,
  slackWorkspaceRef: null,
};

const MAX_REVIEWERS = 64;
const MAX_EMAIL_LEN = 254;
const MAX_FIELD_LEN = 256;

const Email = v.pipe(
  v.string(),
  v.transform((s) => s.trim()),
  v.email(),
  v.maxLength(MAX_EMAIL_LEN),
);

const ReviewerEmails = v.pipe(
  v.array(Email),
  v.maxLength(MAX_REVIEWERS),
  v.transform((arr) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const email of arr) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
    return out;
  }),
);

// nullable string that trims, drops empty-after-trim to null, and caps length.
const TrimmedNullable = v.pipe(
  v.nullable(v.string()),
  v.transform((s): string | null => {
    if (s === null) return null;
    const trimmed = s.trim();
    return trimmed.length > 0 ? trimmed : null;
  }),
  v.nullable(v.pipe(v.string(), v.maxLength(MAX_FIELD_LEN))),
);

export const ProjectSettingsPatchSchema = v.partial(
  v.object({
    notifyOnComment: v.boolean(),
    notifyOnReviewComplete: v.boolean(),
    defaultReviewerEmails: ReviewerEmails,
    defaultOverlayId: TrimmedNullable,
    slackWorkspaceRef: TrimmedNullable,
  }),
);

export type ProjectSettingsPatch = v.InferOutput<typeof ProjectSettingsPatchSchema>;

export class SettingsNotFoundError extends Error {
  constructor() {
    super("project_not_found");
    this.name = "SettingsNotFoundError";
  }
}

export async function loadProjectSettings(opts: {
  projectId: string;
  userId: string;
}): Promise<ProjectSettingsView> {
  const proj = await loadOwnedProject(opts.projectId, opts.userId);
  return hydrateView(proj.settings);
}

export async function updateProjectSettings(opts: {
  projectId: string;
  userId: string;
  patch: ProjectSettingsPatch;
}): Promise<ProjectSettingsView> {
  const proj = await loadOwnedProject(opts.projectId, opts.userId);
  const before = hydrateView(proj.settings);
  const next = applyPatch(before, opts.patch);
  const storedNext = toStored(next, proj.settings);

  await db
    .update(project)
    .set({ settings: storedNext })
    .where(eq(project.id, proj.id));

  await db.insert(auditLog).values({
    actorUserId: opts.userId,
    action: "project.settings.update",
    targetType: "project",
    targetId: proj.id,
    before: before as unknown as Record<string, unknown>,
    after: next as unknown as Record<string, unknown>,
  });

  return next;
}

async function loadOwnedProject(
  projectId: string,
  userId: string,
): Promise<typeof project.$inferSelect> {
  const proj = await getOwnedProject(projectId, userId);
  if (!proj) throw new SettingsNotFoundError();
  return proj;
}

function hydrateView(stored: ProjectSettings): ProjectSettingsView {
  return {
    notifyOnComment: stored.notifyOnComment ?? DEFAULTS.notifyOnComment,
    notifyOnReviewComplete:
      stored.notifyOnReviewComplete ?? DEFAULTS.notifyOnReviewComplete,
    defaultReviewerEmails:
      stored.defaultReviewerEmails ?? DEFAULTS.defaultReviewerEmails,
    defaultOverlayId: stored.defaultOverlayId ?? DEFAULTS.defaultOverlayId,
    slackWorkspaceRef: stored.slackWorkspaceRef ?? DEFAULTS.slackWorkspaceRef,
  };
}

function toStored(
  view: ProjectSettingsView,
  prior: ProjectSettings,
): ProjectSettings {
  return {
    ...prior,
    notifyOnComment: view.notifyOnComment,
    notifyOnReviewComplete: view.notifyOnReviewComplete,
    defaultReviewerEmails: view.defaultReviewerEmails,
    defaultOverlayId: view.defaultOverlayId ?? undefined,
    slackWorkspaceRef: view.slackWorkspaceRef ?? undefined,
  };
}

function applyPatch(
  base: ProjectSettingsView,
  patch: ProjectSettingsPatch,
): ProjectSettingsView {
  const next: ProjectSettingsView = { ...base };
  if (patch.notifyOnComment !== undefined) next.notifyOnComment = patch.notifyOnComment;
  if (patch.notifyOnReviewComplete !== undefined) {
    next.notifyOnReviewComplete = patch.notifyOnReviewComplete;
  }
  if (patch.defaultReviewerEmails !== undefined) {
    next.defaultReviewerEmails = patch.defaultReviewerEmails;
  }
  if (patch.defaultOverlayId !== undefined) next.defaultOverlayId = patch.defaultOverlayId;
  if (patch.slackWorkspaceRef !== undefined) next.slackWorkspaceRef = patch.slackWorkspaceRef;
  return next;
}
