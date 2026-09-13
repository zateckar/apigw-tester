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

Default gateway target is the bundled Petstore on this same process (so everything works out of the box). To test a real gateway open **Configure → API Gateway** and set the base URL + API key, or set `GW_BASE_URL` / `GW_API_KEY` in the environment.

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
5. Watch the **Contract validation** tile. It reports `invalidSent`, how many the gateway rejected with a 4xx, and — the one to care about — `wronglyAccepted`: contract violations your gateway let through.

`invalidRatioPct` (default **2%**) controls that slice. The violations cover missing required properties, wrong primitive types, out-of-enum values, out-of-range numbers, bad path types, and malformed SOAP envelopes. Set it to `0` for a pure-conformance run.

## Production deployment

Full runbook: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In brief, the compose file and image are intended to be safe on the public internet:

- **Authentication is mandatory.** The container exits at startup with a FATAL if `APP_BASIC_AUTH` (`name:password`) is unset. Every route — UI, petstore, admin, metrics, definitions — requires the same `Authorization: Basic …` header, checked with a constant-time comparison **before** any request body is parsed. Only `/health` is public, deliberately, for load-balancer probes (status, version and uptime only).
- **Security headers on every response.** CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`; `X-Powered-By` disabled; HSTS added only when the request arrived over TLS. CI asserts these on the built image.
- **Single bounded port.** `EXPOSE 8080`, `USER node`, `no-new-privileges` — no root, no extra listeners.
- **Persistent state.** `/app/data` is a named volume with the SQLite file and the `config` table (GW + load-profile settings survive restarts). SIGTERM flushes pending metrics and checkpoints the WAL before exiting.
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
| Shared types | `packages/shared/` | Types **and** the config sanitizers the server, driver and UI all share |

## Development

```bash
npm install        # needs Node >= 22.5 (node:sqlite); .nvmrc pins 22
npm run build      # shared → app → ui (each cleans its own dist first)
npm test           # 122 tests across the monorepo, ~13s
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

**How the "GW overhead" metric works.** Each stress class (`small-rest`, `soap`, `big-response`, `big-request`, `slow-upstream`, `concurrency`, `invalid`) has an associated baseline profile. At startup and then once a minute, the driver calls the same class's endpoint **directly against the in-process Petstore** (bypassing any gateway), measures the latency distribution, and stores it. Every outgoing request then carries `latencyMs` (through the GW) and `overheadMs = max(0, latencyMs − baselineMs(class))`. The dashboard's top-row tile, the "GW overhead" time series, and the per-class table all read that — so the number you see is how slow your gateway makes each call class compared with raw target.

## Load profiles

Controlled from the UI drawer (`Configure → Load profile`) or directly:

```bash
curl -u admin:your-strong-password \
  -X PUT http://localhost:8080/api/config/profile \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "real", "rps": 25,
    "maxConcurrency": 50,
    "soapRatioPct": 20,
    "invalidRatioPct": 2,
    "scenarioWeights": { "listPets": 50, "getPet": 20, "createPet": 10, "updatePet": 5, "deletePet": 5, "placeOrder": 10 }
  }'
```

`soapRatioPct`, `invalidRatioPct` and `scenarioWeights` all genuinely drive the generated mix. Out-of-range values are clamped, not rejected, and the clamped profile is echoed back in the response.

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
| `GET /api/summary?window=5m\|15m\|1h\|6h\|24h\|7d` | Totals, error %, p50/p90/p95/p99, bytes, per-protocol & per-endpoint & per-class, plus the `contract` block |
| `GET /api/timeseries?bucket=60\|3600&from&to` | Bucketed chart points (span clamped to 10 000 points; `truncated: true` when clipped) |
| `GET /api/recent?limit=N` | Latest raw requests (1 ≤ N ≤ 500) |
| `GET/PUT /api/config/gateway`, `/api/config/profile` | Persisted config, sanitized on write |
| `GET /api/definitions` | Index of the downloadable contract documents |
| `GET /api/definitions/openapi.json\|.yaml`, `/api/definitions/petservice.wsdl` | The contract, as attachments |
| `POST /api/run/start` · `POST /api/run/stop` · `GET /api/run/status` | Run control |
| `GET /api/runs` | Run history |
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
2. `image` (`needs: build-test`, push only) — multi-stage docker build from `Dockerfile`, push to `ghcr.io/<owner>/apigw-tester:<sha>` and `:latest`, then a **smoke test**: asserts the container does not run as root, that unauthorized requests get 401 and authorized get 200, that `/health` reports a version and every response carries the security headers with no `X-Powered-By`, downloads and structurally validates the OpenAPI/YAML/WSDL, fires a real load run with a 10% invalid slice and checks that metrics flow, that the per-endpoint and per-class breakdowns reconcile with the headline total, that no invalid request was wrongly accepted, that a hostile `timeseries` range is clamped rather than fatal, and that the container is still healthy afterwards.
