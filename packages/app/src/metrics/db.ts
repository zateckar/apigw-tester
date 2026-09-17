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
      server_ms REAL,
      connect_ms REAL,
      conn_reused INTEGER,
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
      conn_setups INTEGER NOT NULL DEFAULT 0,
      conn_setup_sum_ms REAL NOT NULL DEFAULT 0,
      conn_measured INTEGER NOT NULL DEFAULT 0,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      status_hist TEXT NOT NULL DEFAULT '[]',
      -- time spent outside the backend (ttfb - serverMs - connectMs), one
      -- observation per request, so it reads at any percentile over any window
      nb_count INTEGER NOT NULL DEFAULT 0,
      nb_sum_ms REAL NOT NULL DEFAULT 0,
      nb_hist TEXT NOT NULL DEFAULT '[]',
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
      conn_setups INTEGER NOT NULL DEFAULT 0,
      conn_setup_sum_ms REAL NOT NULL DEFAULT 0,
      conn_measured INTEGER NOT NULL DEFAULT 0,
      hist TEXT NOT NULL,
      overhead_hist TEXT NOT NULL DEFAULT '[]',
      status_hist TEXT NOT NULL DEFAULT '[]',
      -- time spent outside the backend (ttfb - serverMs - connectMs), one
      -- observation per request, so it reads at any percentile over any window
      nb_count INTEGER NOT NULL DEFAULT 0,
      nb_sum_ms REAL NOT NULL DEFAULT 0,
      nb_hist TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (bucket_ts, protocol, endpoint, cls)
    );

    -- Scheduler accounting: what the profile asked for vs what the concurrency
    -- ceiling let us issue. Without this a throttled run silently delivers less
    -- load than the chart claims and the latency looks better for it.
    CREATE TABLE IF NOT EXISTS load_shed (
      bucket_ts INTEGER PRIMARY KEY,
      dropped INTEGER NOT NULL DEFAULT 0,
      -- measurements lost for requests that WERE served: the opposite
      -- diagnosis to dropped, and just as invalidating
      results_lost INTEGER NOT NULL DEFAULT 0,
      -- requests issued that never reached the target: a refused connect, a
      -- dial timeout, a name that would not resolve. Kept out of the gateway's
      -- error rate and accounted here instead, because they are the
      -- generator's failure and reporting them as the gateway's is a lie the
      -- numbers cannot be walked back from
      gen_faults INTEGER NOT NULL DEFAULT 0,
      target_sum REAL NOT NULL DEFAULT 0,
      ticks INTEGER NOT NULL DEFAULT 0
    );

    -- Requests each run contributed to each minute.
    --
    -- The roll-ups deliberately carry no run id — endpoint × class × minute is
    -- already the granularity that makes them cheap — so a per-run report is
    -- "everything in the minutes this run touched" and needs a way to say how
    -- much of that was someone else's. requests_raw used to answer it, back
    -- when it held every request; it now holds a bounded tail, and a count off
    -- a sample is not a count. Two integers and a string per (minute, run).
    CREATE TABLE IF NOT EXISTS run_minute (
      bucket_ts INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_ts, run_id)
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

    -- Worker health per minute: the same question as host_health, asked of the
    -- process that actually held the stopwatch. With the Go backend every clock
    -- is read inside the worker, so this process's event loop says nothing
    -- about the numbers and that one's scheduler says everything.
    --
    -- Rolled to the minute from HEALTH_WINDOW_MS cells. The maxima are what the
    -- verdict reads — one stalled 2s window inside a minute is exactly the
    -- event worth surfacing, and a mean over the minute would bury it.
    CREATE TABLE IF NOT EXISTS worker_health (
      bucket_ts INTEGER PRIMARY KEY,
      windows INTEGER NOT NULL DEFAULT 0,
      samples INTEGER NOT NULL DEFAULT 0,
      sched_p99_max REAL NOT NULL DEFAULT 0,
      sched_max_max REAL NOT NULL DEFAULT 0,
      cpu_max REAL NOT NULL DEFAULT 0
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
  // The two-arm overhead Δ is gone and with it its tables. Dropping rather than
  // leaving them: nothing writes them, nothing reads them, and the retention
  // sweep no longer prunes them — so on an existing database they would sit
  // there holding every row they ever took, forever. The measurement they
  // supported is now a column on rollup_*, which does get swept.
  db.exec(`
    DROP TABLE IF EXISTS residual_minute;
    DROP TABLE IF EXISTS residual_hour;
  `);
  return db;
}

/** Add a column if an older database predates it. Safe to call on every boot. */
export function ensureColumn(db: DbHandle, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
