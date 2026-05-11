import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { requireUserByEmail } from "../domain/user.ts";
import { googleDocUrl, parseGoogleDocId } from "../domain/google-doc-url.ts";
import { fatal, usage, dispatchSubcommands } from "./util.ts";

const USAGE = `\
usage:
  bun margin e2e seed-project <doc-url-or-id> [--user <email>] [--label <l>]

Writes a project + one synthetic version row pointing at <doc>, bypassing
the normal Drive validation in createProject/createVersion. Use only
against a local dev DB while driving the chrome-devtools-mcp harness.

--user defaults to $MARGIN_TEST_USER_EMAIL when present. The owning user
must already exist (run \`bun margin connect\` once with that account).

Gated on MARGIN_ALLOW_E2E_SEED=1 — set it in your shell or .env first.`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    "seed-project": seedProject,
  });

async function seedProject(rest: string[]): Promise<void> {
  if (Bun.env.MARGIN_ALLOW_E2E_SEED !== "1") {
    fatal(
      "refusing to seed: set MARGIN_ALLOW_E2E_SEED=1 to confirm this is a non-prod DB",
    );
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      user: { type: "string" },
      label: { type: "string" },
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) usage(USAGE);

  const docId = parseGoogleDocId(target);
  const userEmail = values.user ?? Bun.env.MARGIN_TEST_USER_EMAIL;
  if (!userEmail) {
    fatal(
      "no user: pass --user <email> or set MARGIN_TEST_USER_EMAIL so the seed picks the right owner",
    );
  }
  const owner = await requireUserByEmail(userEmail);

  const existing = await db
    .select()
    .from(project)
    .where(eq(project.parentDocId, docId))
    .limit(1);

  let projectId: string;
  let created = false;
  if (existing[0]) {
    projectId = existing[0].id;
    if (existing[0].ownerUserId !== owner.id) {
      fatal(
        `doc ${docId} already tracked by a different owner (project=${projectId}); pick another doc`,
      );
    }
  } else {
    const inserted = await db
      .insert(project)
      .values({ parentDocId: docId, ownerUserId: owner.id, settings: {} })
      .returning();
    projectId = inserted[0]!.id;
    created = true;
  }

  const versions = await db
    .select()
    .from(version)
    .where(eq(version.projectId, projectId));
  let versionId: string;
  if (versions[0]) {
    versionId = versions[0].id;
  } else {
    const v = await db
      .insert(version)
      .values({
        projectId,
        googleDocId: docId,
        parentVersionId: null,
        label: values.label ?? "v1",
        createdByUserId: owner.id,
        snapshotContentHash: null,
        status: "active",
      })
      .returning();
    versionId = v[0]!.id;
  }

  console.log(`${created ? "✓ created" : "· reused"} project ${projectId}`);
  console.log(`  parent doc: ${docId}`);
  console.log(`  url: ${googleDocUrl(docId)}`);
  console.log(`  owner: ${owner.email}`);
  console.log(`  version: ${versionId}`);
}
