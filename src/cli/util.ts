import * as v from "valibot";
import { requireFirstUser, resolveUserByEmailOrFirst } from "../domain/user.ts";

/**
 * Friendlier aliases for the most common CLI lookup patterns. New code is
 * welcome to call `domain/user.ts` directly; these short names exist so the
 * existing CLI parse-and-call shells stay terse.
 */
export const defaultUser = requireFirstUser;
export const resolveUser = resolveUserByEmailOrFirst;

/**
 * Print a usage message and exit 2. Use for "wrong command-line invocation"
 * errors — exit 2 is the Unix convention for misuse, distinct from runtime
 * failures.
 */
export function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

/**
 * Print an operational error and exit 1. Use for runtime failures: missing
 * DB rows the CLI was told existed, a config the operator must fix, etc.
 */
export function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

export type SubcommandHandler = (args: string[]) => Promise<void>;

/**
 * Parse `args[0]` as a subcommand name and forward the remainder to the
 * matching handler. Centralizes the `if (!sub) usage(USAGE); if (sub === "x")
 * { … } usage(USAGE);` chain that every subcommand dispatcher in `cli/`
 * was reimplementing. If `sub` is missing or unknown, prints `text` to
 * stderr and exits 2 (usage error).
 */
/**
 * Coerce a string CLI flag into a number, running it through a valibot schema
 * for range/integer/etc. checks. Returns `undefined` when the flag is unset.
 * Calls `usage(...)` (which exits 2) on validation failure, with the flag
 * name + valibot's issue message.
 */
export function parseNumberArg(
  raw: string | undefined,
  schema: v.GenericSchema<number, number>,
  flag: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  const result = v.safeParse(schema, n);
  if (!result.success) {
    usage(`${flag}: ${result.issues[0].message} (got ${JSON.stringify(raw)})`);
  }
  return result.output;
}

export async function dispatchSubcommands(
  args: string[],
  text: string,
  table: Record<string, SubcommandHandler>,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub) usage(text);
  const handler = table[sub];
  if (!handler) usage(text);
  await handler(rest);
}
