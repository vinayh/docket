import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./client.ts";

migrate(db, { migrationsFolder: "./drizzle" });
console.log("migrations applied");
