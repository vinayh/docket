import { parseArgs } from "node:util";
import * as v from "valibot";
import { startServer } from "../api/server.ts";
import { sqlite } from "../db/client.ts";
import { parseNumberArg } from "./util.ts";

const USAGE = `\
usage:
  bun margin serve [--port <n>]`;

export async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
    },
    allowPositionals: false,
  });

  const port = parseNumberArg(
    values.port,
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)),
    "--port",
  );

  const server = startServer(port !== undefined ? { port } : {});
  console.log(`margin api listening on http://${server.hostname}:${server.port}`);

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    await server.stop();
    // Close SQLite to checkpoint the WAL before exit.
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
