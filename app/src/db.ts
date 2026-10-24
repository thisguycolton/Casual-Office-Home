import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = DatabaseSync;

/**
 * Opens (and migrates) the SQLite database.
 * NOTE: `node:sqlite` is flagged experimental by Node 22. It is confined to this module so it can be
 * swapped (e.g. for better-sqlite3) without touching callers.
 */
export function openDb(path: string, migrationsDir: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Db, dir: string): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}

/** Run `fn` in a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
