// bun:sqlite is a first-class import under the single Bun runtime — no more
// lazy createRequire dance to keep vitest from bundling node:sqlite.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Stmt = import("bun:sqlite").Statement;
export type DbHandle = Database;

export function openDb(path: string): DbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL DEFAULT '',
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
      reached_backend INTEGER NOT NULL DEFAULT 0,
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
      reached_backend INTEGER NOT NULL DEFAULT 0,
      rejected4xx_gw INTEGER NOT NULL DEFAULT 0,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      status_hist TEXT NOT NULL DEFAULT '[]',
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
      reached_backend INTEGER NOT NULL DEFAULT 0,
      rejected4xx_gw INTEGER NOT NULL DEFAULT 0,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      status_hist TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (bucket_ts, protocol, endpoint, cls)
    );

    -- Scheduler accounting: what the profile asked for vs what the concurrency
    -- ceiling let us issue. Without this a throttled run silently delivers less
    -- load than the chart claims and the latency looks better for it.
    CREATE TABLE IF NOT EXISTS load_shed (
      bucket_ts INTEGER PRIMARY KEY,
      dropped INTEGER NOT NULL DEFAULT 0,
      target_sum REAL NOT NULL DEFAULT 0,
      ticks INTEGER NOT NULL DEFAULT 0
    );

    -- Host health per minute, so a window older than the sampler's in-memory
    -- ring can still be judged trustworthy or not.
    CREATE TABLE IF NOT EXISTS host_health (
      bucket_ts INTEGER PRIMARY KEY,
      samples INTEGER NOT NULL DEFAULT 0,
      cpu_sum REAL NOT NULL DEFAULT 0,
      cpu_max REAL NOT NULL DEFAULT 0,
      loop_p99_sum REAL NOT NULL DEFAULT 0,
      loop_p99_max REAL NOT NULL DEFAULT 0
    );

    -- Latest outcome per gateway policy probe; one row per policy, overwritten.
    CREATE TABLE IF NOT EXISTS policy_results (
      id TEXT PRIMARY KEY,
      checked_at INTEGER NOT NULL,
      payload TEXT NOT NULL
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
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
