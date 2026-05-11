import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

export const sqlite = new Database(config.dbPath, { create: true, strict: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA synchronous = NORMAL;");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

/**
 * True when `err` is a SQLite UNIQUE-constraint violation. Used by upsert
 * paths that wrap a SELECT-then-INSERT in a transaction: the unique index
 * is the backstop for the read-then-write race, and the caller re-reads
 * the winner row instead of bubbling the error up.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (message.includes("UNIQUE constraint failed")) return true;
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}
