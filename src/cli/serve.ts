import { parseArgs } from "node:util";
import { startServer } from "../api/server.ts";

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
  if (port !== undefined && Number.isNaN(port)) {
    console.error(USAGE);
    process.exit(1);
  }

  const server = startServer(port !== undefined ? { port } : {});
  console.log(`docket api listening on http://${server.hostname}:${server.port}`);

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
