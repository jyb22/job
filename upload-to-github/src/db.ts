import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "..", "migrations");

export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Apply any migration files that have not run yet, in filename order. Returns the names applied. */
export function migrate(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    })();
    applied.push(file);
  }
  return applied;
}

/**
 * Run `fn` inside a write transaction that takes the database write lock up
 * front (BEGIN IMMEDIATE). SQLite allows one writer at a time, so everything
 * inside is atomic and serialised against every other writer — this is the
 * product-level lock the inventory code relies on.
 */
export function writeTx<T>(db: DB, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}
