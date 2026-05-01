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
