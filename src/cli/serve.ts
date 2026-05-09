import { parseArgs } from "node:util";
import { startServer } from "../api/server.ts";
import { sqlite } from "../db/client.ts";
import { usage } from "./util.ts";

const USAGE = `\
usage:
  bun docket serve [--port <n>]`;

export async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
    },
    allowPositionals: false,
  });

  const port = values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && Number.isNaN(port)) usage(USAGE);

  const server = startServer(port !== undefined ? { port } : {});
  console.log(`docket api listening on http://${server.hostname}:${server.port}`);

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    await server.stop();
    // Close the SQLite handle so WAL is checkpointed before exit. Without
    // this, a crash window between server.stop() and process.exit() could
    // leave uncommitted WAL pages that recovery has to reapply on restart.
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
