/**
 * Build the extension into `surfaces/extension/dist/{chromium,firefox}/`. Each
 * target gets its own manifest and a copy of the bundled JS / static assets.
 *
 * Run with `bun run surfaces/extension/build.ts`. Pass `--watch` to rebuild on
 * source change. Pass `--target=chromium|firefox` to skip the other target.
 */

import { resolve, dirname } from "node:path";
import { mkdir, copyFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir);
const SRC = resolve(ROOT, "src");
const STATIC = resolve(ROOT, "static");
const DIST = resolve(ROOT, "dist");

type Target = "chromium" | "firefox";
const TARGETS: Target[] = ["chromium", "firefox"];

interface Entry {
  /** Path under `src/` for the source. */
  source: string;
  /** Output path under the target dist root (without extension for JS). */
  output: string;
}

const JS_ENTRIES: Entry[] = [
  {
    source: "background/service-worker.ts",
    output: "background/service-worker.js",
  },
  { source: "content/docs-content.ts", output: "content/docs-content.js" },
  { source: "options/options.ts", output: "options/options.js" },
  { source: "popup/popup.ts", output: "popup/popup.js" },
  { source: "popup/picker-sandbox.ts", output: "popup/picker-sandbox.js" },
];

const STATIC_ENTRIES: Entry[] = [
  { source: "options/options.html", output: "options/options.html" },
  { source: "options/options.css", output: "options/options.css" },
  { source: "popup/popup.html", output: "popup/popup.html" },
  { source: "popup/popup.css", output: "popup/popup.css" },
  { source: "popup/picker-sandbox.html", output: "popup/picker-sandbox.html" },
  { source: "popup/picker-sandbox.css", output: "popup/picker-sandbox.css" },
];

async function buildTarget(target: Target): Promise<void> {
  const out = resolve(DIST, target);
  await mkdir(out, { recursive: true });

  const result = await Bun.build({
    entrypoints: JS_ENTRIES.map((e) => resolve(SRC, e.source)),
    outdir: out,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "linked",
    naming: "[dir]/[name].[ext]",
    root: SRC,
  });
  if (!result.success) {
    for (const m of result.logs) console.error(m);
    throw new Error(`bun build failed for ${target}`);
  }

  for (const e of STATIC_ENTRIES) {
    const dest = resolve(out, e.output);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(resolve(SRC, e.source), dest);
  }

  const manifestSource = resolve(ROOT, `manifest.${target}.json`);
  await copyFile(manifestSource, resolve(out, "manifest.json"));

  const iconsSrc = resolve(STATIC, "icons");
  const iconsDest = resolve(out, "icons");
  await mkdir(iconsDest, { recursive: true });
  const supplied = existsSync(iconsSrc) ? await readdir(iconsSrc) : [];
  const copied: string[] = [];
  for (const name of supplied) {
    const s = await stat(resolve(iconsSrc, name));
    if (s.isFile()) {
      await copyFile(resolve(iconsSrc, name), resolve(iconsDest, name));
      copied.push(name);
    }
  }
  // Manifest references these names — fill in the gaps with a 1×1 placeholder
  // so the unpacked extension loads. Replace with real artwork before publish.
  const placeholder = makePlaceholderPng();
  for (const name of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
    if (copied.includes(name)) continue;
    await writeFile(resolve(iconsDest, name), placeholder);
  }

  console.log(`✓ built ${target} → ${out}`);
}

/**
 * Tiny 1×1 PNG (transparent). Avoids a placeholder-icon dependency. Replace
 * with real artwork before publishing.
 */
function makePlaceholderPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
    "base64",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetFilter = args.find((a) => a.startsWith("--target="))?.split("=")[1];
  const watch = args.includes("--watch");

  const selected = targetFilter
    ? TARGETS.filter((t) => t === targetFilter)
    : TARGETS;
  if (selected.length === 0) {
    console.error(`unknown target: ${targetFilter}`);
    process.exit(1);
  }

  for (const t of selected) await buildTarget(t);

  if (!watch) return;

  console.log("watching for changes…");
  const watcher = (await import("node:fs")).watch(
    SRC,
    { recursive: true },
    (event, filename) => {
      if (!filename) return;
      console.log(`change: ${filename} (${event})`);
      Promise.all(selected.map(buildTarget)).catch((err) => {
        console.error(err);
      });
    },
  );
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

await main();
