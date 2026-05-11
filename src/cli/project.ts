import { parseArgs } from "node:util";
import { createProject, listAllProjects } from "../domain/project.ts";
import { usage, dispatchSubcommands, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun margin project create <doc-url-or-id> [--user <email>]
  bun margin project list`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    create: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { user: { type: "string" } },
        allowPositionals: true,
      });
      const target = positionals[0];
      if (!target) usage(USAGE);

      const owner = await resolveUser(values.user);
      const project = await createProject({
        ownerUserId: owner.id,
        parentDocUrlOrId: target,
      });
      console.log(`✓ created project ${project.id}`);
      console.log(`  parent doc: ${project.parentDocId}`);
      console.log(`  owner: ${owner.email}`);
    },

    list: async () => {
      const projects = await listAllProjects();
      if (projects.length === 0) {
        console.log("no projects.");
        return;
      }
      for (const p of projects) {
        console.log(
          `${p.id}  parent=${p.parentDocId}  owner=${p.ownerUserId}  created=${p.createdAt.toISOString()}`,
        );
      }
    },
  });
