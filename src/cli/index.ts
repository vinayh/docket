import { run as runConnect } from "./connect.ts";
import { run as runSmoke } from "./smoke.ts";
import { run as runProject } from "./project.ts";
import { run as runVersion } from "./version.ts";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  connect: runConnect,
  smoke: runSmoke,
  project: runProject,
  version: runVersion,
};

const [name, ...rest] = process.argv.slice(2);

if (!name || name === "--help" || name === "-h" || !commands[name]) {
  const known = Object.keys(commands).join(" | ");
  console.error(`usage: bun docket <${known}> [...args]`);
  process.exit(name && !commands[name] ? 1 : 0);
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
