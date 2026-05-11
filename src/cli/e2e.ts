import { parseArgs } from "node:util";
import { config } from "../config.ts";
import { googleDocUrl, parseGoogleDocId } from "../domain/google-doc-url.ts";
import {
  seedDevProject,
  SeedOwnerMismatchError,
} from "../domain/dev-seed.ts";
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
  if (!config.allowE2eSeed) {
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
  const userEmail = values.user ?? config.testUserEmail;
  if (!userEmail) {
    fatal(
      "no user: pass --user <email> or set MARGIN_TEST_USER_EMAIL so the seed picks the right owner",
    );
  }

  let result;
  try {
    result = await seedDevProject({
      parentDocId: docId,
      ownerEmail: userEmail,
      versionLabel: values.label,
    });
  } catch (err) {
    if (err instanceof SeedOwnerMismatchError) {
      fatal(`${err.message}; pick another doc`);
    }
    throw err;
  }

  console.log(`${result.createdProject ? "✓ created" : "· reused"} project ${result.projectId}`);
  console.log(`  parent doc: ${result.parentDocId}`);
  console.log(`  url: ${googleDocUrl(result.parentDocId)}`);
  console.log(`  owner: ${result.ownerEmail}`);
  console.log(`  version: ${result.versionId}`);
}
