import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";

export function openDatabase(path: string): Database {
  const db = new Database(path);
  runMigrations(db);
  return db;
}
