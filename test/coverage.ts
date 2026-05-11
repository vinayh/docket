import { resolve } from "path";

const DEFAULT_EXCLUDE = [".test.ts", ".d.ts"];
// CLI entry points and the migrator have top-level execution that would fire
// during preload. Coverage doesn't gain anything useful from those anyway.
const MARGIN_EXCLUDE = ["cli/index.ts", "db/migrate.ts"];

export async function importAllModules(
  dir: string,
  exclude: string[] = [],
): Promise<void> {
  const allExclude = [...DEFAULT_EXCLUDE, ...exclude];
  const glob = new Bun.Glob("**/*.ts");
  const files = [...glob.scanSync(dir)].filter(
    (f) => !allExclude.some((pattern) => f.endsWith(pattern)),
  );

  await Promise.all(
    files.map((relPath) => import(new URL(relPath, `file://${dir}/`).href)),
  );
}

await importAllModules(resolve(import.meta.dir, "../src"), MARGIN_EXCLUDE);
