import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { auditLog, project, type ProjectSettings } from "../db/schema.ts";

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

export class SettingsNotFoundError extends Error {
  constructor() {
    super("project_not_found");
    this.name = "SettingsNotFoundError";
  }
}

export class SettingsBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsBadRequestError";
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
  patch: Partial<ProjectSettingsView>;
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
  const rows = await db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  const proj = rows[0];
  if (!proj || proj.ownerUserId !== userId) {
    throw new SettingsNotFoundError();
  }
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
  patch: Partial<ProjectSettingsView>,
): ProjectSettingsView {
  const next: ProjectSettingsView = { ...base };
  if (patch.notifyOnComment !== undefined) {
    requireBoolean("notifyOnComment", patch.notifyOnComment);
    next.notifyOnComment = patch.notifyOnComment;
  }
  if (patch.notifyOnReviewComplete !== undefined) {
    requireBoolean("notifyOnReviewComplete", patch.notifyOnReviewComplete);
    next.notifyOnReviewComplete = patch.notifyOnReviewComplete;
  }
  if (patch.defaultReviewerEmails !== undefined) {
    next.defaultReviewerEmails = normalizeReviewers(patch.defaultReviewerEmails);
  }
  if (patch.defaultOverlayId !== undefined) {
    next.defaultOverlayId = normalizeOptionalString(
      "defaultOverlayId",
      patch.defaultOverlayId,
    );
  }
  if (patch.slackWorkspaceRef !== undefined) {
    next.slackWorkspaceRef = normalizeOptionalString(
      "slackWorkspaceRef",
      patch.slackWorkspaceRef,
    );
  }
  return next;
}

function requireBoolean(field: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new SettingsBadRequestError(`${field} must be boolean`);
  }
}

function normalizeReviewers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new SettingsBadRequestError("defaultReviewerEmails must be an array");
  }
  if (value.length > MAX_REVIEWERS) {
    throw new SettingsBadRequestError(
      `defaultReviewerEmails capped at ${MAX_REVIEWERS} entries`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new SettingsBadRequestError("defaultReviewerEmails entries must be strings");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_EMAIL_LEN || !trimmed.includes("@")) {
      throw new SettingsBadRequestError(`invalid email: ${trimmed}`);
    }
    const lowered = trimmed.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    out.push(trimmed);
  }
  return out;
}

function normalizeOptionalString(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SettingsBadRequestError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_FIELD_LEN) {
    throw new SettingsBadRequestError(`${field} too long`);
  }
  return trimmed;
}
