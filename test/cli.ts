/**
 * Run `bun src/cli/index.ts <args…>` as a subprocess. The child inherits
 * `MARGIN_DB_PATH` + `MARGIN_MASTER_KEY` + `BETTER_AUTH_SECRET` from the
 * parent test process so both operate on the same temp SQLite (WAL mode
 * handles cross-process concurrency). `env` overrides individual vars;
 * pass `undefined` to unset a single variable in the child.
 */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
