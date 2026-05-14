import { parseArgs } from "node:util";
import * as v from "valibot";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { startServer } from "../api/server.ts";
import { db, sqlite } from "../db/client.ts";
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

  // Apply pending migrations before the server binds. The Dockerfile invokes
  // `bun src/db/migrate.ts` ahead of `serve`; running it here too lets
  // `bun margin serve` outside the container match that contract instead of
  // surfacing schema drift as a 500 from `no such column: …`.
  migrate(db, { migrationsFolder: "./drizzle" });

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
