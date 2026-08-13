# kody status worker

The public status page for kody, served at
[status.kody.codes](https://status.kody.codes). It is deliberately a separate
Cloudflare Worker with its own storage so it stays up when the main worker's
deploys, code, or database are broken (see decision record 0004).

`status.heykody.dev` remains a worker custom domain for legacy links. The worker
308s GET/HEAD from that host to `status.kody.codes`, except `/health`, which
stays sticky so deploys can still probe the worker if the canonical hostname
returns Cloudflare 1016 until DNS exists. Component probes never use the status
hostname, so a 1016 on `status.kody.codes` does not turn App, MCP, runtime, or
Jobs red.

## How it works

- A cron trigger runs one probe pass per minute:
  - `GET /health` and `GET /health/components` on the primary origin
    (`kody.codes`)
  - the unauthenticated OAuth challenge on `/mcp`
  - package-runtime liveness `GET /__runtime/health` on `kody.run` (JSON
    `status: "ok"`; an apex 302 is not up)
  - jobs-worker `GET /health` and `GET /health/components` over a service
    binding (no public jobs hostname; JOBS_DB rides on the Jobs component)
- A single `StatusStore` Durable Object (SQLite) stores per-minute samples (24
  h), daily uptime rollups (90 days), incidents, and sent notifications.
- A component opens an incident after two consecutive probe failures and
  resolves it after two consecutive successes.
- Operator alert emails go to `ALERT_EMAIL_TO` through the Cloudflare Email REST
  API: one email when an outage starts, at most one reminder per day while it
  lasts, one all-clear when everything has recovered, all under a daily cap
  (`STATUS_ALERT_DAILY_LIMIT`). Alert links use `STATUS_PAGE_URL`
  (`https://status.kody.codes`).

## Provider incidents (Cloudflare)

Each cron tick also fetches Cloudflare's public Statuspage feed
(`incidents/unresolved.json`, no auth, short timeout) and caches a filtered
subset in the Durable Object (~60s refresh, stale-tolerant for a few minutes).
Only incidents whose affected components intersect products kody runs on are
kept: Workers, D1, R2, Workers KV, Durable Objects, Queues, Vectorize, Email
Routing, and Access. Regional PoPs, Stream, Magic Transit, and other unrelated
products are dropped.

When that filtered list is non-empty, the status page renders a clearly
separated **Provider incidents (Cloudflare)** section. It is provider-declared
context only — never merged into kody's measured health or uptime numbers. If
the Statuspage API is slow or unreachable, the page omits the section (fail
soft). Outage alert emails get one annotation line per active relevant incident
(`Possibly related Cloudflare incident: …`); alerts are never gated or
suppressed based on provider status.

## Routes

| Path           | Purpose                               |
| -------------- | ------------------------------------- |
| `/`            | Public status page (HTML)             |
| `/status.json` | Snapshot as JSON                      |
| `/health`      | Liveness for the status worker itself |

## Deploy

Deployed by `.github/workflows/deploy.yml` (path-filtered job, like the backup
control plane) with `npm run status:deploy`. The `CLOUDFLARE_API_TOKEN` Worker
secret (Email Sending permission) is synced at deploy time; without it, alert
emails are skipped and logged.

Wrangler attaches both `status.kody.codes` and `status.heykody.dev` as custom
domains. If `status.kody.codes` still returns Cloudflare 1016 after deploy, the
`kody.codes` zone still needs a `status` DNS record so that custom domain can
attach. The deploy healthcheck tries the canonical `/health` first and falls
back to `status.heykody.dev/health`; other component probes do not depend on
either hostname.
