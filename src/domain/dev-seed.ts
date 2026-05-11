import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { requireUserByEmail } from "./user.ts";

/**
 * Dev-only synthetic project + version seed (SPEC §12 Phase 2 test rig).
 *
 * Used exclusively by the chrome-devtools-mcp E2E harness to pre-populate a
 * project pointing at a real doc without paying the Drive validation cost
 * `createProject` and `createVersion` incur in normal flow. Lives in the
 * domain layer so the CLI side stays a parse-and-call shell.
 *
 * Idempotent: re-running against the same doc reuses the existing project +
 * version rows. Cross-owner conflicts surface as an error so the harness
 * doesn't silently bind to someone else's project row.
 */
export interface SeedDevProjectResult {
  projectId: string;
  versionId: string;
  ownerEmail: string;
  parentDocId: string;
  /** True when this call inserted the project row; false when it reused one. */
  createdProject: boolean;
}

export class SeedOwnerMismatchError extends Error {
  readonly projectId: string;
  readonly docId: string;
  constructor(projectId: string, docId: string) {
    super(
      `doc ${docId} already tracked by a different owner (project=${projectId})`,
    );
    this.name = "SeedOwnerMismatchError";
    this.projectId = projectId;
    this.docId = docId;
  }
}

export async function seedDevProject(opts: {
  parentDocId: string;
  ownerEmail: string;
  versionLabel?: string;
}): Promise<SeedDevProjectResult> {
  const owner = await requireUserByEmail(opts.ownerEmail);

  const existingProj = (
    await db
      .select()
      .from(project)
      .where(eq(project.parentDocId, opts.parentDocId))
      .limit(1)
  )[0];

  let projectId: string;
  let createdProject = false;
  if (existingProj) {
    projectId = existingProj.id;
    if (existingProj.ownerUserId !== owner.id) {
      throw new SeedOwnerMismatchError(existingProj.id, opts.parentDocId);
    }
  } else {
    const inserted = await db
      .insert(project)
      .values({ parentDocId: opts.parentDocId, ownerUserId: owner.id, settings: {} })
      .returning();
    projectId = inserted[0]!.id;
    createdProject = true;
  }

  const existingVersion = (
    await db
      .select()
      .from(version)
      .where(eq(version.projectId, projectId))
      .limit(1)
  )[0];

  let versionId: string;
  if (existingVersion) {
    versionId = existingVersion.id;
  } else {
    const inserted = await db
      .insert(version)
      .values({
        projectId,
        googleDocId: opts.parentDocId,
        parentVersionId: null,
        label: opts.versionLabel ?? "v1",
        createdByUserId: owner.id,
        snapshotContentHash: null,
        status: "active",
      })
      .returning();
    versionId = inserted[0]!.id;
  }

  return {
    projectId,
    versionId,
    ownerEmail: owner.email,
    parentDocId: opts.parentDocId,
    createdProject,
  };
}
