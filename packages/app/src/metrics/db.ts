// Dynamic import deferred to runtime so vitest/vite don't try to bundle node:sqlite
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

type Stmt = { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown };
export type DbHandle = {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
};

const req = createRequire(import.meta.url);

export function openDb(path: string): DbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // node:sqlite ships with Node 22.5+; not typed for TS yet, so load lazily
  const mod = req("node:sqlite") as { DatabaseSync: new (p: string) => DbHandle };
  const db = new mod.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'small-rest',
      method TEXT NOT NULL,
      status INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      baseline_ms REAL NOT NULL DEFAULT 0,
      overhead_ms REAL NOT NULL DEFAULT 0,
      bytes_req INTEGER NOT NULL,
      bytes_resp INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_raw_ts ON requests_raw(ts);

    CREATE TABLE IF NOT EXISTS rollup_minute (
      bucket_ts INTEGER NOT NULL,
      protocol TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      cls TEXT NOT NULL DEFAULT 'small-rest',
      count INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      ok2xx INTEGER NOT NULL DEFAULT 0,
      rejected4xx INTEGER NOT NULL DEFAULT 0,
      latency_sum_ms REAL NOT NULL,
      max_latency_ms REAL NOT NULL,
      overhead_sum_ms REAL NOT NULL DEFAULT 0,
      overhead_max_ms REAL NOT NULL DEFAULT 0,
      bytes_req INTEGER NOT NULL,
      bytes_resp INTEGER NOT NULL,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (bucket_ts, protocol, endpoint, cls)
    );

    CREATE TABLE IF NOT EXISTS rollup_hour (
      bucket_ts INTEGER NOT NULL,
      protocol TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      cls TEXT NOT NULL DEFAULT 'small-rest',
      count INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      ok2xx INTEGER NOT NULL DEFAULT 0,
      rejected4xx INTEGER NOT NULL DEFAULT 0,
      latency_sum_ms REAL NOT NULL,
      max_latency_ms REAL NOT NULL,
      overhead_sum_ms REAL NOT NULL DEFAULT 0,
      overhead_max_ms REAL NOT NULL DEFAULT 0,
      bytes_req INTEGER NOT NULL,
      bytes_resp INTEGER NOT NULL,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (bucket_ts, protocol, endpoint, cls)
    );

    CREATE TABLE IF NOT EXISTS ingest_seen (
      batch_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seen_received ON ingest_seen(received_at);

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      profile TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
  `);
  return db;
}

/** Add a column if an older database predates it. Safe to call on every boot. */
export function ensureColumn(db: DbHandle, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
