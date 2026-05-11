import {
  requireFirstUser,
  resolveUserByEmailOrFirst,
  type User,
} from "../domain/user.ts";

export type { User };

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
