# Deployment

Operational runbook for running `apigw-tester` as a long-lived service. For what
the tool *is* and how to use it, see the [README](../README.md).

## 1. Prerequisites

- A host with Docker and the Compose plugin, or any runtime that can run an OCI image.
- A TLS-terminating reverse proxy in front of it (Caddy, nginx, Traefik, a cloud LB,
  a Cloudflare tunnel). The container speaks plain HTTP on `:8080` and **must not**
  be exposed directly to the internet, because Basic credentials would travel in clear.
- Outbound network reachability from the host to the gateway under test.

## 2. Configure

```bash
cp .env.example .env
# edit .env: set APP_BASIC_AUTH, and GW_BASE_URL if you are testing a real gateway
```

`APP_BASIC_AUTH` is **mandatory** — the process logs a FATAL and exits 1 if it is
unset, so a misconfigured deploy fails loudly instead of coming up unauthenticated.

Never commit `.env`. For a real deployment, source the credential from your secret
store instead of a file on disk:

```bash
APP_BASIC_AUTH="$(pass show apigw-tester)" docker compose up -d
```

Every variable is listed in [`.env.example`](../.env.example). Settings changed later
through the dashboard are persisted in SQLite and survive restarts; the environment
only supplies the defaults used on a fresh volume.

## 3. Run

```bash
docker compose up -d          # builds locally
docker compose logs -f
```

To run a CI-built image instead of building on the host:

```bash
IMAGE=ghcr.io/<owner>/apigw-tester:v1.0.0 docker compose up -d
```

Pin a version tag in production rather than `:latest`, so a redeploy is a decision
rather than a surprise.

## 4. Verify the deploy

```bash
curl -s https://your-host/health                       # {"status":"ok","version":"1.0.0","uptimeSec":N}
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/summary   # 401 — auth is on
curl -s -u admin:… https://your-host/api/run/status
```

`/health` is the only unauthenticated route and reports nothing an anonymous caller
could use — status, version, uptime.

## 5. Point it at the gateway

1. Dashboard → **Configure → API Gateway**, set the base URL and API key (or set
   `GW_BASE_URL` / `GW_API_KEY` before first start).
2. **API definitions** panel → download `openapi.json` / `openapi.yaml` /
   `petservice.wsdl`. Add `?server=https://your-gw/base` to make the documents
   advertise the gateway's own URL.
3. Import into the gateway, enable request/response validation.
4. Start a run and watch the **Contract validation** tile. `wronglyAccepted` is the
   number that matters: contract violations your gateway let through.

## 6. Operate

| Concern | Where |
|---|---|
| Liveness / readiness | `GET /health`, plus the image's own `HEALTHCHECK` |
| Persistent state | named volume `app-data` → `/app/data/metrics.db` (SQLite, WAL) |
| Log volume | capped by compose at 3 × 10 MB (`json-file` rotation) |
| Graceful stop | SIGTERM flushes pending metrics and checkpoints the WAL; `stop_grace_period: 15s` |
| Restart policy | `unless-stopped` |
| Privilege | runs as `node` (uid 1000), `no-new-privileges:true`, single exposed port |

### Backup

The whole state is one SQLite file. Back it up while the container runs:

```bash
docker compose exec app sh -c 'cd /app/data && sqlite3 metrics.db ".backup /tmp/b.db"' \
  2>/dev/null || docker compose stop app
docker run --rm -v apigw-tester_app-data:/data -v "$PWD:/out" alpine \
  tar czf /out/apigw-tester-data.tgz -C /data .
docker compose start app
```

`sqlite3` is not installed in the image, so in practice: stop the container (SIGTERM
checkpoints the WAL), tar the volume, start it again. Downtime is a few seconds.

### Upgrade

```bash
IMAGE=ghcr.io/<owner>/apigw-tester:v1.1.0 docker compose up -d
```

The schema is migrated forward in place on startup (columns are added if absent).
There is no automatic downgrade — back up the volume before a major version bump.

### Reset

```bash
npm run compose:down     # stop, keep the metrics volume
npm run compose:reset    # stop and DESTROY the metrics volume
```

## 7. Resource expectations

The rig is an always-on load generator; size it for the load *you* configure.

- At `rps: 25` with the default mix: well under 100 MB RSS, negligible CPU.
- A retention sweep runs every 10 minutes: raw request rows are kept 24 h, minute
  roll-ups 7 days, hour roll-ups 90 days, and the WAL is checkpointed with
  `TRUNCATE`. The database file therefore settles at a high-water mark and reuses
  freed pages rather than growing without bound. (SQLite does not return the space
  to the filesystem; run `VACUUM` offline if you need the file itself to shrink.)
- The built-in Petstore is bounded by FIFO eviction, so a multi-day run does not
  degrade the SUT.
- The `big-response` class allocates up to 10 MB per request. At high `rps` with a
  heavy `big-response` weight, memory is dominated by in-flight bodies — that is
  what `maxConcurrency` is for.

If you want a hard ceiling, add one to compose:

```yaml
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "2.0"
```

## 8. Security posture

- Auth on every route but `/health`, constant-time comparison, checked **before**
  any request body is parsed.
- `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Cross-Origin-Opener-Policy` on every response; `X-Powered-By`
  disabled; HSTS added only on requests that arrived over TLS.
- Every operator-supplied number — load profile, query ranges, `X-Test-*` headers,
  admin latency profiles — is clamped to a documented range, so neither a saved
  config nor a crafted URL can wedge or OOM the process.
- The gateway API key is stored in the SQLite file in plain text. Treat the volume
  as a secret-bearing artifact.
- CI asserts on every push that the built image runs as non-root, rejects
  unauthenticated calls, and emits the security headers above.
