# apigw-tester

A self-contained, always-on test rig for an **API gateway**: it continuously hammers the gateway with realistic Petstore traffic (REST + SOAP), captures per-request metrics, and shows everything on a live dashboard — **as one process, one port, one Docker container**.

```
┌────────────────────────────────────────────────────────┐
│                     apigw-tester                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │  React dashboard (served from / , poll /api/*)    │ │
│  ├──────────────────────────────────────────────────┤ │
│  │  Metrics store (node:sqlite, minute+hour roll-ups)│ │
│  ├──────────────────────────────────────────────────┤ │
│  │  Load driver  ── in-process ──►  metrics store    │ │
│  │      │                                            │ │
│  │      └── HTTP/SOAP ──► target gateway             │ │
│  │             (default: built-in petstore, this app)│ │
│  └──────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Petstore SUT  (/api/pets, /soap/petservice)     │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Quick start

```bash
docker compose up --build -d
# open http://localhost:8080
```

That's the whole stack. The dashboard opens on the same port as the API; Petstore is the SUT at `/api/pets` (REST) and `/soap/petservice` (SOAP) on the same port; the load driver starts stopped, hit **Start run** in the UI to begin.

Default gateway target is the bundled Petstore on `127.0.0.1:8080` (so everything works out of the box). To test a real gateway open **Configure → API Gateway** and set the base URL + API key.

## What's inside

| Piece | Where | Notes |
|---|---|---|
| Petstore SUT | `packages/app/src/petstore/` | REST CRUD + SOAP WSDL; per-endpoint latency distributions, response padding, optional chaos via `/admin/*` |
| Load driver | `packages/app/src/loadgen/` | Token-bucket scheduler; modes `constant / ramp / spike / sine-daily`; weighted scenario mix; bounded spool; day-long runs |
| Metrics store | `packages/app/src/metrics/` | `node:sqlite` (no native deps), WAL mode, 24h raw ring + minute + hour histogram roll-ups |
| Dashboard | `packages/ui/` | React 18 + Recharts + TanStack Query, dark theme |
| Shared types | `packages/shared/` | Everything the layers share |

## Development

```bash
npm install        # needs Node >= 22.5 (node:sqlite)
npm run build      # shared → app → ui, then bake ui/dist into app/dist/public
npm test           # 41 tests across the monorepo
npm run compose:up # one container on :8080
```

Run locally without Docker:

```bash
npm run build
cp -r packages/ui/dist packages/app/dist/public
npm start          # serves on http://localhost:8080
```

## Load profiles

Controlled from the UI drawer (`Configure → Load profile`) or directly:

```bash
curl -X PUT http://localhost:8080/api/config/profile \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "constant", "rps": 25,
    "maxConcurrency": 25,
    "soapRatioPct": 25,
    "scenarioWeights": { "listPets": 50, "getPet": 20, "createPet": 10, "updatePet": 5, "deletePet": 5, "placeOrder": 10 }
  }'
```

Modes: `constant`, `ramp`, `spike`, `sine-daily` (day/night pattern). Start/stop runs:

```bash
curl -X POST http://localhost:8080/api/run/start -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:8080/api/run/stop
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

`.github/workflows/ci.yml` runs: lint → typecheck → unit tests → full `docker build` + `docker compose` smoke test that starts a tiny load run and asserts metrics flow.
