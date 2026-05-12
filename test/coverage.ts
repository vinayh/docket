import { resolve } from "path";

const DEFAULT_EXCLUDE_SUFFIX = [".test.ts", ".d.ts"];
// Coverage doesn't gain anything useful from these:
//   - `cli/**`     — thin `parseArgs` shells per AGENTS.md; the underlying
//                    logic is in `src/domain/` and is covered there. CLI
//                    entrypoints are also operator tooling, not in the
//                    request path.
//   - `db/migrate.ts` — top-level execution that would fire during preload.
const MARGIN_EXCLUDE_PREFIX = ["cli/"];
const MARGIN_EXCLUDE_SUFFIX = ["db/migrate.ts"];

export async function importAllModules(
  dir: string,
  excludePrefix: string[] = [],
  excludeSuffix: string[] = [],
): Promise<void> {
  const suffixes = [...DEFAULT_EXCLUDE_SUFFIX, ...excludeSuffix];
  const glob = new Bun.Glob("**/*.ts");
  const files = [...glob.scanSync(dir)].filter(
    (f) =>
      !suffixes.some((p) => f.endsWith(p)) &&
      !excludePrefix.some((p) => f.startsWith(p)),
  );

  await Promise.all(
    files.map((relPath) => import(new URL(relPath, `file://${dir}/`).href)),
  );
}

await importAllModules(
  resolve(import.meta.dir, "../src"),
  MARGIN_EXCLUDE_PREFIX,
  MARGIN_EXCLUDE_SUFFIX,
);
