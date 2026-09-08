# apigw-tester

A self-contained, always-on test rig for an **API gateway**: it continuously hammers the gateway with realistic Petstore traffic (REST + SOAP), captures **per-request metrics including how much the gateway is adding to each call**, and shows everything on a live dashboard — **as one process, one port, one Docker container, secured with Basic auth**.

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
│  │      │  small-rest | soap | big-response           │ │
│  │      │  big-request | slow-upstream | concurrency │ │
│  │      └── HTTP/SOAP ──► target gateway             │ │
│  │             (default: built-in petstore, this app)│ │
│  └──────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Petstore SUT  (/api/pets, /soap/petservice)     │ │
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

That's the whole stack. The dashboard opens on the same port as the API; Petstore is the SUT at `/api/pets` (REST) and `/soap/petservice` (SOAP) on the same port; the load driver starts stopped, hit **Start run** in the UI to begin.

Default gateway target is the bundled Petstore on `127.0.0.1:8080` (so everything works out of the box). To test a real gateway open **Configure → API Gateway** and set the base URL + API key.

## Production deployment

The compose file and image are intended to be safe on the public internet:

- **Authentication is mandatory.** The container exits at startup with a FATAL if `APP_BASIC_AUTH` (`name:password`) is unset. Every route — UI, petstore, admin, metrics — requires the same `Authorization: Basic …` header. Only `/health` is public, deliberately, for load-balancer probes (returns just `{status: "ok"}`).
- **Single bounded port.** `EXPOSE 8080`, `USER node` — no root, no extra listeners.
- **Persistent state.** `/app/data` is a named volume with the SQLite file and the `config` table (GW + load-profile settings survive restarts).
- **Credentials via env or secret store only.** Never commit `APP_BASIC_AUTH` to git. For a real deployment source it from `APP_BASIC_AUTH=$(pass show apigw)` / Docker secrets / your orchestrator's secret mount.
- **TLS terminate upstream.** Put the container behind your reverse proxy (Caddy, nginx, Traefik, cloudflare tunnel) so Basic credentials never transit the internet in plain text.

Health checks online: `GET /health` — no auth needed.

```yaml
# docker-compose.yml snippet for a production host
services:
  app:
    image: ghcr.io/<owner>/apigw-tester:latest
    environment:
      APP_BASIC_AUTH: ${APP_BASIC_AUTH:?'set a credentialed name:password'}
    volumes: [app-data:/app/data]
```

You can also pull the image built by CI directly:
`docker pull ghcr.io/<owner>/apigw-tester:latest` or a versioned tag (`ghcr.io/<owner>/apigw-tester:v1.0.0`).

## What's inside

| Piece | Where | Notes |
|---|---|---|
| Petstore SUT | `packages/app/src/petstore/` | REST CRUD + SOAP WSDL; per-endpoint latency distributions, response padding, optional chaos via `/admin/*`. Stress endpoints: `GET /api/big/:size`, `GET /api/slow/:ms`, `POST /api/echo` |
| Load driver | `packages/app/src/loadgen/` | Token-bucket scheduler; modes `constant / ramp / spike / sine-daily / real`; weighted scenario + stress-class mix; per-class baseline (direct-to-SUT) probes |
| Metrics store | `packages/app/src/metrics/` | `node:sqlite` (no native deps), WAL mode, 24h raw ring + minute + hour histogram roll-ups with per-class use |
| Dashboard | `packages/ui/` | React 18 + Recharts + TanStack Query, dark theme; "GW overhead" is the headline metric |
| Shared types | `packages/shared/` | Everything the layers share |

## Development

```bash
npm install        # needs Node >= 22.5 (node:sqlite)
npm run build      # shared → app → ui, then bake ui/dist into app/dist/public
npm test           # 51 tests across the monorepo
npm run compose:up # one container on :8080 (must set APP_BASIC_AUTH first)
```

Run locally without Docker:

```bash
$env:APP_BASIC_AUTH = "admin:dev-local"   # or export on Linux/macOS
npm run build
cp -r packages/ui/dist packages/app/dist/public
npm start          # serves on http://localhost:8080 with auth
```

**How the "GW overhead" metric works.** Each stress class (`small-rest`, `soap`, `big-response`, `big-request`, `slow-upstream`, `concurrency`) has an associated baseline profile. Once a minute the driver calls the same class's endpoint **directly against the in-process Petstore** (bypassing any gateway), measures the latency distribution, and stores it. Every outgoing request then carries `latencyMs` (through the GW) and `overheadMs = latencyMs − baselineMs(class)`. The dashboard's top-row tile, the "GW overhead" time series, and the per-class table all read that — so the number you see is how slow your gateway makes each call class compared with raw target.

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
    "scenarioWeights": { "listPets": 50, "getPet": 20, "createPet": 10, "updatePet": 5, "deletePet": 5, "placeOrder": 10 }
  }'
```

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
| `GET /api/summary?window=5m|15m|1h|24h` | Totals, error %, p50/p90/p95/p99, bytes, per-protocol & per-endpoint |
| `GET /api/timeseries?bucket=60\|3600&from&to` | Bucketed chart points |
| `GET /api/recent?limit=N` | Latest raw requests |
| `GET/PUT /api/config/gateway`, `/api/config/profile` | Persisted config |
| `POST /api/run/start` · `POST /api/run/stop` · `GET /api/run/status` | Run control |
| `GET /api/runs` | Run history |
| `GET /health` | Liveness |

## Petstore variability knobs

- `X-Test-Delay-Ms: 4000` request header — force that latency for the call
- `X-Test-Size-B: 500000` — pad the response to roughly that size
- `GET/PATCH /admin/latency-profile` — per-endpoint latency distributions (`fixed`, `uniform`, `normal`)
- `PUT /admin/chaos` `{ "errorRatePct": 5, "timeoutRatePct": 1 }` — fault injection so you can verify the error panels light up

## CI

`.github/workflows/ci.yml`:

1. `build-test` (fast) — lint, `tsc --noEmit`, 51 unit tests.
2. `image` (`needs: build-test`) — multi-stage docker build from `ops/Dockerfile.app`, push to `ghcr.io/<owner>/apigw-tester:<sha>` and `:latest`, then a **smoke test**: pulls the image, runs it with a test credential, asserts unauthorized requests get 401, authorized get 200, then fires a short real load run and verifies metrics flow into the DB.
