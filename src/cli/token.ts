import { parseArgs } from "node:util";
import { issueApiToken, listApiTokens, revokeApiToken } from "../auth/api-token.ts";
import { usage, dispatchSubcommands, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun docket token issue [--user <email>] [--label <label>]
  bun docket token list  [--user <email>]
  bun docket token revoke <token-id>`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    issue: async (rest) => {
      const { values } = parseArgs({
        args: rest,
        options: {
          user: { type: "string" },
          label: { type: "string" },
        },
        allowPositionals: false,
      });
      const u = await resolveUser(values.user);
      const { token, row } = await issueApiToken({ userId: u.id, label: values.label });
      console.log(`✓ issued token for ${u.email} (id=${row.id}, label=${row.label ?? "—"})`);
      console.log("");
      console.log("  paste this into the extension's Options page:");
      console.log("");
      console.log(`    ${token}`);
      console.log("");
      console.log("  it will not be shown again.");
    },

    list: async (rest) => {
      const { values } = parseArgs({
        args: rest,
        options: { user: { type: "string" } },
        allowPositionals: false,
      });
      const u = await resolveUser(values.user);
      const rows = await listApiTokens(u.id);
      if (rows.length === 0) {
        console.log(`no tokens for ${u.email}`);
        return;
      }
      console.log(`tokens for ${u.email}:`);
      for (const r of rows) {
        const last = r.lastUsedAt ? r.lastUsedAt.toISOString() : "never";
        console.log(
          `  ${r.id}  ${r.tokenPreview}  label=${r.label ?? "—"}  last_used=${last}`,
        );
      }
    },

    revoke: async ([tokenId]) => {
      if (!tokenId) usage(USAGE);
      const ok = await revokeApiToken(tokenId);
      if (ok) console.log(`✓ revoked ${tokenId}`);
      else console.log(`token ${tokenId} not found or already revoked`);
    },
  });
