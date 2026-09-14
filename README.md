# apigw-tester

A self-contained, always-on test rig for an **API gateway**: it continuously hammers the gateway with realistic Petstore traffic (REST + SOAP), captures **per-request metrics including how much the gateway is adding to each call**, and shows everything on a live dashboard — **as one process, one port, one Docker container, secured with Basic auth**.

It ships the **OpenAPI and WSDL definitions of its own Petstore**, so you can import them into the gateway, switch **content validation** on, and know that the traffic conforms — apart from a small, configurable slice that is deliberately invalid so you can watch the gateway reject exactly that and nothing else.

```
┌────────────────────────────────────────────────────────┐
│                     apigw-tester                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │  React dashboard (served from / , poll /api/*)    │ │
│  ├──────────────────────────────────────────────────┤ │
│  │  Metrics store (node:sqlite, minute+hour roll-ups)│ │
│  │         baseline: direct-to-SUT vs through-GW     │ │
│  ├──────────────────────────────────────────────────┤ │
│  │  Load driver  ── class-tagged requests            │ │
│  │      │  small-rest | soap | big-response          │ │
│  │      │  big-request | slow-upstream | concurrency │ │
│  │      │  invalid  (contract violations, on purpose)│ │
│  │      └── HTTP/SOAP ──► target gateway             │ │
│  │             (default: built-in petstore, this app)│ │
│  ├──────────────────────────────────────────────────┤ │
│  │  Petstore SUT  (/api/pets, /soap/petservice)     │ │
│  │    + OpenAPI 3.0 + WSDL, downloadable             │ │
│  │    + synthetic endpoints for GW stress testing:   │ │
│  │    /api/big/:size  /api/slow/:ms  /api/echo       │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Quick start

```powershell
# One command, mandatory credential picked up from environment
$env:APP_BASIC_AUTH = "admin:your-strong-password"
docker compose up --build -d
# open http://localhost:8080 (Basic auth, your name/password)
```

Or copy `.env.example` to `.env`, fill it in, and `docker compose up -d`.
Running it as a real service? See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

That's the whole stack: **one container, one port**. The dashboard, the API, the Petstore SUT and the load driver all live in the same process. There is no separate nginx or UI container — the app serves the built dashboard itself, behind the same auth gate.

Default gateway target is the bundled Petstore on this same process (so everything works out of the box). To test a real gateway open **Configure → API Gateway** and set the base URL + API key for **REST and SOAP separately** — a real gateway usually fronts them at different URLs/keys. Environment equivalents are `GW_REST_*` / `GW_SOAP_*` (`GW_REST_BASE_URL`, `GW_REST_API_KEY`, …); the legacy `GW_BASE_URL` / `GW_API_KEY` / `GW_API_KEY_HEADER` / `GW_PATH_PREFIX` still work and apply to both protocols when the protocol-specific variable is unset.

**The rig's own credential is not sent to your gateway.** `APP_BASIC_AUTH` guards this dashboard; the bundled petstore needs it, an external gateway must never see it. `forwardBasicAuth` (`GW_REST_FORWARD_BASIC_AUTH` / `GW_SOAP_FORWARD_BASIC_AUTH`, or the drawer) controls this per target:

- **`auto`** (default) — forward only when the target resolves to this process. Your gateway gets the configured API key and nothing else, so the admin password never lands in a third party's access log and the gateway's own auth is not confused by a header it did not ask for.
- **`always`** — forward regardless. Only if the gateway is configured to accept or pass through the same credential.
- **`never`** — never forward.

The same rule governs **Test connection**, and its result reports `sentBasicAuth` so a 401 can be read correctly.

## Testing a gateway with content validation

1. Point the rig at your gateway (**Configure → API Gateway**, or `GW_BASE_URL`).
2. Download the contract from the dashboard's **API definitions** panel, or directly:

```bash
curl -u admin:pw -O http://localhost:8080/api/definitions/openapi.json
curl -u admin:pw -O http://localhost:8080/api/definitions/openapi.yaml
curl -u admin:pw -O http://localhost:8080/api/definitions/petservice.wsdl
```

   Add `?server=https://your-gw/base` to make the documents advertise the gateway's own URL instead of the configured target.
3. Import them into the gateway and enable request/response validation.
4. Start a run. **All generated traffic conforms to those documents**, except the `invalid` class.
5. Watch the **Blocked by gateway** tile. It reports `invalidSent`, `rejectedByGateway`, and — the one to care about — `leakedToBackend`: contract violations your gateway let through.

**How "blocked by the gateway" is established.** The bundled petstore validates its own input too, so "the request came back 4xx" on its own proves nothing: the tile would read ~100% blocked whether or not gateway validation was even switched on. The tie-breaker is the SUT's `X-Server-Ms` response header — a response carrying it demonstrably came *from the backend*, so the gateway passed the request through. Hence:

| Field | Meaning |
|---|---|
| `rejectedByGateway` | 4xx with no `X-Server-Ms` — the gateway stopped it. **This is the number that proves validation works.** |
| `rejectedByBackend` | 4xx *with* `X-Server-Ms` — the gateway let it past and the SUT caught it |
| `leakedToBackend` | reached the backend at all. With gateway content validation on and configured, this must be **0** |
| `wronglyAccepted` | answered 2xx — a violation nobody caught |

The same header drives the **Answered by** column in the recent-requests table, so you can see per request whether the gateway or the backend produced the response.

`invalidRatioPct` (default **2%**) controls that slice. The violations cover missing required properties, wrong primitive types, out-of-enum values, out-of-range numbers, bad path types, and malformed SOAP envelopes. Set it to `0` for a pure-conformance run.

## Gateway policy checks

Load proves a gateway can *proxy*. It says nothing about whether the gateway's **policies** actually fire, and a quota or payload cap that was configured but is silently not applied is the failure mode no latency chart will ever show. So eight deliberate probes run on their own cadence, each with a stated expectation:

| Probe | Sends | Passes when |
|---|---|---|
| `auth-bad-key` | `GET /api/pets` with a wrong API key | 401/403 **and no `X-Server-Ms`** |
| `auth-no-key` | the same with no credential at all | 401/403 |
| `payload-limit` | `POST /api/echo` with a 12 MB body | 413, a gateway-made 400, or the connection cut mid-upload |
| `upstream-timeout` | `GET /api/slow/10000` | a clean 504, or the full response — never a dangling connection |
| `cache` | the same GET twice | the second answer has no `X-Server-Ms`, or carries `X-Cache`/`Age` |
| `unknown-route` | `GET /api/definitely-not-a-route` | 404/405 without consulting the backend |
| `cors-preflight` | `OPTIONS /api/pets` with `Origin` | 2xx with `Access-Control-Allow-Origin` |
| `rate-limit` | 40 identical GETs fired concurrently | at least one 429, ideally with `Retry-After` |

Three rules keep the results honest:

- **`X-Server-Ms` decides who answered.** A 401 *with* the header means the gateway forwarded a request it should have stopped — the right status for the wrong reason. That is a `fail`, not a `pass`.
- **"Not configured" is not "broken".** A gateway with no cache and no quota is a legitimate gateway, so those report **`not-enforced`** — a third state, not a failure. It becomes a failure only for policies you list in `required`.
- **A 429 is not an answer to any other question.** The burst probe exhausts the quota on purpose and runs **last**; if anything else is throttled anyway (live load, a per-minute quota), it reports `error`, not a fabricated "expected 413, got 429".

Every probe except the two auth ones sends the configured API key — otherwise, on a gateway that checks keys, all six would just measure the auth policy again.

```bash
curl -u admin:pw -X PUT http://localhost:8080/api/policy \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "intervalSec": 300, "required": ["auth-bad-key", "rate-limit"] }'
curl -u admin:pw -X POST http://localhost:8080/api/policy/run   # run a pass now
curl -u admin:pw http://localhost:8080/api/policy               # config + last results
```

The probes are deliberately abusive against the same gateway you are measuring, hence the **300 s** default interval; a pass also runs automatically when a run starts, so even a short acceptance run carries policy results in its report. `POST /api/policy/run` answers **409** when probing is disabled rather than accepting a pass that will never happen.

## Measurement validity

A load generator that cannot keep up makes the *gateway* look better: it issues fewer requests, and the ones it does issue are the ones the machine had room for. Every window therefore carries a `validity` block, and the dashboard says so above the fold when it fails:

| Signal | Invalid when | Why |
|---|---|---|
| `shedPct` | > 1 % of the intended load was never issued | the concurrency ceiling throttled the generator — the target rate was never actually offered to the gateway |
| `cpuProcessPctMax` | > 85 % | the rig is competing with itself for CPU |
| `eventLoopP99MsMax` | > 100 ms | every latency in the window is inflated by that stall, whatever the gateway did |

`droppedRequests` is counted by the scheduler itself — tokens it wanted to spend and could not — so "8 rps target → 7.9 rps achieved" appears as a KPI instead of being silently invisible. A window that fails the gate cannot produce a pass verdict (see below).

## Bounded runs, SLOs and the per-run report

Set `durationMinutes` on the load profile and the run stops itself, recording its own stop time — an acceptance run you can start from CI and come back to:

```bash
curl -u admin:pw -X PUT http://localhost:8080/api/config/profile \
  -H "Content-Type: application/json" \
  -d '{ "mode": "constant", "rps": 25, "durationMinutes": 10, "invalidRatioPct": 5 }'
curl -u admin:pw -X POST http://localhost:8080/api/run/start -d '{}' -H "Content-Type: application/json"
```

Thresholds are configured once (`Configure → Pass/fail thresholds`, or `PUT /api/config/slo`). **`null` means "not asserted"** and is kept distinct from `0`:

| Field | Default | Checks |
|---|---|---|
| `maxOverheadP95Ms` | `null` | gateway overhead p95, in ms |
| `maxUnexpectedFailurePct` | `1` | non-2xx/3xx minus the deliberate invalid slice |
| `maxLeakedToBackend` | `0` | contract violations that reached the backend |
| `maxGatewayErrorPct` | `0.5` | 502/503/504 + no-response |
| `requirePolicies` | `true` | every policy listed in `required` is enforced |

```bash
curl -u admin:pw http://localhost:8080/api/runs/<runId>/report      # JSON
curl -u admin:pw -O http://localhost:8080/api/runs/<runId>/report.md # shareable Markdown
```

The report is scoped to the run's own window and leads with a verdict:

- **pass** — every asserted threshold held.
- **fail** — at least one did, and the report names which, with the actual value beside the limit.
- **inconclusive** — no traffic, nothing asserted, or **the window failed the validity gate**. A saturated generator inflates every latency it reports, so calling that a pass would be a lie and calling it a fail would blame the gateway for the rig's own throttling.

API keys are redacted from the report, because a report exists to be handed to someone else.

The window is resolved to the minute buckets the run touched — roll-ups carry no run id — so back-to-back short runs share their first and last bucket. The raw table *does* carry one, so every report states its **window purity**: how many of the requests in the window belong to some other run. Above 1 % the verdict is `inconclusive` rather than a confident judgement of the wrong traffic. An acceptance run should still be minutes long, not seconds.

## Production deployment

Full runbook: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In brief, the compose file and image are intended to be safe on the public internet:

- **Authentication is mandatory.** The container exits at startup with a FATAL if `APP_BASIC_AUTH` (`name:password`) is unset. Every route — UI, petstore, admin, metrics, definitions — requires the same `Authorization: Basic …` header, checked with a constant-time comparison **before** any request body is parsed. Only `/health` is public, deliberately, for load-balancer probes (status, version and uptime only).
- **Security headers on every response.** CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`; `X-Powered-By` disabled; HSTS added only when the request arrived over TLS. CI asserts these on the built image.
- **Single bounded port.** `EXPOSE 8080`, `no-new-privileges` — one listener, and the server process runs as `node`, never root. The entrypoint holds root only long enough to `chown /app/data`, then `su-exec`s down to `node`, which becomes PID 1 and receives SIGTERM directly.
- **Persistent state.** `/app/data` is a named volume with the SQLite file and the `config` table (GW + load-profile settings survive restarts). SIGTERM flushes pending metrics and checkpoints the WAL before exiting. Docker seeds a named volume's ownership from the image only when the volume is empty, so a volume carried over from an older image — or a host bind mount — can arrive owned by root; `docker-entrypoint.sh` repairs that on every start rather than letting SQLite fail with `unable to open database file` in a restart loop.
- **Bounded by construction.** Every operator-supplied number — load profile, query ranges, `X-Test-*` headers, admin latency profiles — is clamped to a documented range, so neither a saved config nor a crafted URL can wedge or OOM the process.
- **Credentials via env or secret store only.** Never commit `APP_BASIC_AUTH` to git. For a real deployment source it from `APP_BASIC_AUTH=$(pass show apigw)` / Docker secrets / your orchestrator's secret mount.
- **TLS terminate upstream.** Put the container behind your reverse proxy (Caddy, nginx, Traefik, cloudflare tunnel) so Basic credentials never transit the internet in plain text.

```yaml
# docker-compose.yml snippet for a production host
services:
  app:
    image: ghcr.io/<owner>/apigw-tester:latest
    environment:
      APP_BASIC_AUTH: ${APP_BASIC_AUTH:?'set a credentialed name:password'}
    volumes: [app-data:/app/data]
    stop_grace_period: 15s
```

You can also pull the image built by CI directly:
`docker pull ghcr.io/<owner>/apigw-tester:latest` or a versioned tag (`ghcr.io/<owner>/apigw-tester:v1.0.0`).

## Repository layout

```
.
├── Dockerfile              production image (multi-stage: ui → server → runtime)
├── docker-compose.yml      one service, one volume, one port
├── .env.example            every supported environment variable
├── docs/DEPLOYMENT.md      production runbook
├── tsconfig.base.json      compiler options every package extends
├── eslint.config.mjs
└── packages/
    ├── shared/             types + config sanitizers (server, driver and UI share them)
    ├── app/                the single Node process
    │   └── src/
    │       ├── index.ts    entrypoint: startup, graceful shutdown
    │       ├── app.ts      composition root: auth, headers, routes, wiring
    │       ├── auth.ts  config.ts
    │       ├── petstore/   the SUT + its OpenAPI/WSDL contract
    │       ├── loadgen/    scheduler, scenario generation, driver
    │       └── metrics/    SQLite schema, roll-ups, query surface
    └── ui/                 React dashboard, built into app/dist/public
```

Tests live next to what they test (`*.test.ts`) and are excluded from the build
and from the Docker context.

## What's inside

| Piece | Where | Notes |
|---|---|---|
| Petstore SUT | `packages/app/src/petstore/` | REST CRUD + SOAP; per-endpoint latency distributions, response padding, optional chaos via `/admin/*`. Stress endpoints: `GET /api/big/:size`, `GET /api/slow/:ms`, `POST /api/echo`. Bounded in-memory store with FIFO eviction and a per-status index, so the SUT does not slow down over a long run |
| API contract | `packages/app/src/petstore/openapi.ts`, `soap.ts` | Hand-written OpenAPI 3.0.3 + WSDL, served as downloads and asserted against the live routes in `contract.test.ts` |
| Load driver | `packages/app/src/loadgen/` | Token-bucket scheduler; modes `constant / ramp / spike / sine-daily / real`; weighted scenario + stress-class mix; per-class baseline (direct-to-SUT) probes |
| Metrics store | `packages/app/src/metrics/` | `node:sqlite` (no native deps), WAL mode, transactional ingest, 24h raw ring + minute + hour histogram roll-ups with per-class use |
| Dashboard | `packages/ui/` | React 18 + Recharts + TanStack Query, dark theme; "GW overhead" is the headline metric |
| Status dimension | `packages/shared/` (`STATUS_BUCKETS`) | Every response is bucketed by status, so 401/403/429 and 502/503/504 are visible instead of folded away — see below |
| Policy probes | `packages/app/src/loadgen/policy.ts` | Eight deliberate probes (auth, quota, payload cap, upstream timeout, cache, route allowlist, CORS) with `pass` / `not-enforced` / `fail` / `error` outcomes |
| Validity gate | `packages/app/src/metrics/server.ts` (`validityFor`) | Load shed + generator CPU/event-loop saturation, so a window the rig could not honestly measure is marked as such |
| Run report | `packages/app/src/report.ts` | Per-run JSON + Markdown with a `pass` / `fail` / `inconclusive` verdict against configured SLOs, API keys redacted |
| Shared types | `packages/shared/` | Types **and** the config sanitizers the server, driver and UI all share |

## Development

```bash
npm install        # needs Node >= 22.5 (node:sqlite); .nvmrc pins 22
npm run build      # shared → app → ui (each cleans its own dist first)
npm test           # 238 tests across the monorepo, ~17s
npm run verify     # lint + typecheck + test, i.e. what CI gates on
npm run compose:up # one container on :8080 (must set APP_BASIC_AUTH first)
```

Run locally without Docker:

```bash
$env:APP_BASIC_AUTH = "admin:dev-local"   # or export on Linux/macOS
npm run build
cp -r packages/ui/dist packages/app/dist/public
npm start          # serves on http://localhost:8080 with auth
```

**What the gateway answered, and whose fault it was.** Every response is bucketed by status (`STATUS_BUCKETS` in `packages/shared`), which keeps three questions apart that a plain "error rate" conflates:

- **`401`/`403`** — the gateway is rejecting your API key. It is not measuring your traffic at all.
- **`429`** — you tripped the gateway's rate limit or quota. Every latency number in that window describes the throttle, not the proxying.
- **`502`/`503`/`504`** and no-response — the gateway's *own* failures: no healthy upstream, circuit open, upstream timed out. Distinct from a `500`, which the gateway merely relayed from the backend.

`unexpectedFailurePct` is the headline health number: everything that did not come back 2xx/3xx, minus the deliberately-invalid slice that is supposed to be rejected. A gateway answering 401 to everything reads **100%** — the old `errorPct`, which counted only 5xx and connection failures, reported a healthy-looking **0%** for exactly that case. The dashboard raises a banner above the fold when any of the three patterns dominates a window.

**Correlating with the gateway's own logs.** Every generated request carries `X-Request-Id` (32 hex chars) and a W3C `traceparent` built from the same id, recorded against the row and shown in the recent-requests table. So "the gateway added 800 ms to some requests" becomes a list of ids you can grep in its access log or open in a trace backend. Ids are drawn from a per-run random prefix plus a counter rather than `randomUUID()` per request — the CPU for that would be charged to the very latency being measured.

**How the "GW overhead" metric works.** The bundled Petstore stamps every response with `X-Server-Ms` — the backend's own entry-to-response time for *that exact request*. The load driver reads it on every through-gateway call and computes `overheadMs = max(0, latencyMs − serverMs − transportMs(class))`, where `transportMs` is a per-class median of direct-to-SUT probes **minus** their own `X-Server-Ms` (i.e. pure client-stack + loopback transport, re-measured once a minute). So per-request backend variability — random sleeps on `/api/slow/:ms`, chaos injection, latency-profile changes mid-run — lands in `baselineMs` and never in the gateway's number. Two cases fall back to the class median as the backend estimate: a gateway-generated rejection (auth wall, contract 4xx) that never touched the SUT, and a real backend that doesn't emit the header.

## Load profiles

Controlled from the UI drawer (`Configure → Load profile`) or directly:

```bash
curl -u admin:your-strong-password \
  -X PUT http://localhost:8080/api/config/profile \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "real", "rps": 25,
    "maxConcurrency": 50,
    "durationMinutes": 0,
    "soapRatioPct": 20,
    "invalidRatioPct": 2,
    "scenarioWeights": { "listPets": 50, "getPet": 20, "createPet": 10, "updatePet": 5, "deletePet": 5, "placeOrder": 10 }
  }'
```

`soapRatioPct`, `invalidRatioPct` and `scenarioWeights` all genuinely drive the generated mix. `durationMinutes` (`0` = run until stopped) makes the run stop itself. Out-of-range values are clamped, not rejected, and the clamped profile is echoed back in the response.

Modes: `constant`, `ramp`, `spike`, `sine-daily`, **`real`** (workweek simulation: workday peaks, lunch dip, overnight dip, slow drift, jitter — starting at a random time-of-day so consecutive runs don't align).

Start/stop runs:

```bash
curl -u admin:your-strong-password -X POST http://localhost:8080/api/run/start \
  -H "Content-Type: application/json" -d '{}'
curl -u admin:your-strong-password -X POST http://localhost:8080/api/run/stop
```

## Metrics API (all same-host, same port)

| Endpoint | Returns |
|---|---|
| `GET /api/summary?window=5m\|15m\|1h\|6h\|24h\|7d` | Totals, failure %, p50/p90/p95/p99, bytes, the `status` distribution, the `validity` block, per-protocol & per-endpoint & per-class, plus the `contract` block |
| `GET /api/timeseries?bucket=60\|3600&from&to` | Bucketed chart points (span clamped to 10 000 points; `truncated: true` when clipped) |
| `GET /api/recent?limit=N` | Latest raw requests (1 ≤ N ≤ 500) |
| `GET/PUT /api/config/gateway`, `/api/config/profile` | Persisted config, sanitized on write. The gateway body is `{ rest: {...}, soap: {...} }` — each side its own `baseUrl` / `apiKey` / `apiKeyHeader` / `pathPrefix` |
| `GET /api/definitions` | Index of the downloadable contract documents |
| `GET /api/definitions/openapi.json\|.yaml`, `/api/definitions/petservice.wsdl` | The contract, as attachments (OpenAPI advertises the REST target, WSDL the SOAP one) |
| `POST /api/run/start` · `POST /api/run/stop` · `GET /api/run/status` | Run control |
| `GET /api/runs` | Run history |
| `GET/PUT /api/policy` · `POST /api/policy/run` | Policy-probe config + last results; on-demand pass (409 while one is running, or while probing is disabled) |
| `GET/PUT /api/config/slo` | Pass/fail thresholds; `null` = not asserted |
| `GET /api/runs/:runId/report` · `report.md` | Per-run report and verdict, JSON or Markdown (404 for an unknown run) |
| `POST /api/metrics/reset` | Wipe all metrics (raw, roll-ups, run history). 409 while a run is live. Config is kept |
| `POST /api/runs/prune` `{ "olderThanDays": N }` | Delete stopped runs older than N days (never a live/unstopped run) |
| `GET /health` | Liveness + build version + uptime (the only unauthenticated route) |

## Petstore variability knobs

- `X-Test-Delay-Ms: 4000` request header — force that latency for the call (clamped to 30 s)
- `X-Test-Size-B: 500000` — pad the response to roughly that size (clamped to 10 MB)
- `GET/PATCH /admin/latency-profile` — per-endpoint latency distributions (`fixed`, `uniform`, `normal`), validated on write
- `PUT /admin/chaos` `{ "errorRatePct": 5, "timeoutRatePct": 1 }` — fault injection so you can verify the error panels light up
- `GET /admin/petstore` — pet/order counts and the live chaos config

## CI

`.github/workflows/ci.yml`:

1. `build-test` (fast) — lint, `tsc --noEmit`, the unit suite, and a full `npm run build`.
2. `image` (`needs: build-test`, push only) — multi-stage docker build from `Dockerfile`, push to `ghcr.io/<owner>/apigw-tester:<sha>` and `:latest`, then a **smoke test**: asserts the container does not run as root, that unauthorized requests get 401 and authorized get 200, that `/health` reports a version and every response carries the security headers with no `X-Powered-By`, downloads and structurally validates the OpenAPI/YAML/WSDL, fires a **bounded** load run with a 10% invalid slice and checks that `durationMinutes` stopped it by itself, that metrics flow, that the per-endpoint and per-class breakdowns reconcile with the headline total, that no invalid request was wrongly accepted, that the `validity` block is populated and agrees with its own reasons, that the policy probes report *not measured* rather than a verdict when there is no gateway in the path, that the run report renders as JSON and Markdown with a verdict that is **never a pass** in that situation, that an unknown run id 404s, that a hostile `timeseries` range is clamped rather than fatal, and that the container is still healthy afterwards.
