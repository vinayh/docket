import { run as runConnect } from "./connect.ts";
import { run as runSmoke } from "./smoke.ts";
import { run as runDoc } from "./doc.ts";
import { run as runInspect } from "./inspect.ts";
import { run as runProject } from "./project.ts";
import { run as runVersion } from "./version.ts";
import { run as runComments } from "./comments.ts";
import { run as runReanchor } from "./reanchor.ts";
import { run as runOverlay, runDerivative } from "./overlay.ts";
import { run as runWatcher } from "./watcher.ts";
import { run as runServe } from "./serve.ts";
import { run as runToken } from "./token.ts";
import { run as runE2E } from "./e2e.ts";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  connect: runConnect,
  smoke: runSmoke,
  doc: runDoc,
  inspect: runInspect,
  project: runProject,
  version: runVersion,
  comments: runComments,
  reanchor: runReanchor,
  overlay: runOverlay,
  derivative: runDerivative,
  watcher: runWatcher,
  serve: runServe,
  token: runToken,
  e2e: runE2E,
};

const [name, ...rest] = process.argv.slice(2);

if (!name || name === "--help" || name === "-h" || !commands[name]) {
  const known = Object.keys(commands).join(" | ");
  console.error(`usage: bun docket <${known}> [...args]`);
  // Unknown command is a usage error (exit 2 per Unix convention); --help is exit 0.
  process.exit(name && !commands[name] ? 2 : 0);
}

try {
  await commands[name](rest);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  if (Bun.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
