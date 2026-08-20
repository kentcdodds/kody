# kody status worker

The public status page for kody, served at
[status.kody.codes](https://status.kody.codes). It is deliberately a separate
Cloudflare Worker with its own storage so it stays up when the main worker's
deploys, code, or database are broken (see decision record 0004).

`status.heykody.dev` is also a worker custom domain. The worker 308s GET/HEAD
from that host to `status.kody.codes`, except `/health`, which is sticky so
deploy healthchecks can probe `status.heykody.dev` when the canonical hostname
returns Cloudflare 1016. Component probes never use the status hostname, so a
1016 on `status.kody.codes` does not turn App, MCP, runtime, or Jobs red.

## How it works

- A cron trigger runs one probe pass per minute:
  - `GET /health` and `GET /health/components` on the primary origin
    (`kody.codes`)
  - the unauthenticated OAuth challenge on `/mcp`
  - package-runtime liveness `GET /__runtime/health` on `kody.run` (JSON
    `status: "ok"`; an apex 302 is not up)
  - jobs-worker `GET /health` and `GET /health/components` over a service
    binding (no public jobs hostname; JOBS_DB rides on the Jobs component)
- Public storage cards are the main-worker bindings that take the product down
  (`app_db`, `kv`, `assets`). Operator `GET /health/components` reports
  `audit_db` as well; it is not a public card and does not open incidents or
  send alert email.
- A single `StatusStore` Durable Object (SQLite) stores per-minute samples (24
  h), daily uptime rollups (90 days), incidents, and sent notifications.
- A component opens an incident after two consecutive probe failures and
  resolves it after two consecutive successes.
- Day bars and the uptime percentage follow those opened incidents. Isolated
  probe failures below the threshold stay in the 24h sample log only — they do
  not increment daily failed counts or paint a day amber. A day turns amber when
  an incident covered it for under an hour and under 5% of that day's probes
  failed; red when the incident lasted an hour or more, or at least 5% of probes
  failed. Cards start at the first day with samples instead of padding empty
  leading days.
- Operator alert emails go to `ALERT_EMAIL_TO` through the Cloudflare Email REST
  API: one email when an outage starts, at most one reminder per day while it
  lasts, one all-clear when everything has recovered, all under a daily cap
  (`STATUS_ALERT_DAILY_LIMIT`). Alert links use `STATUS_PAGE_URL`
  (`https://status.kody.codes`).

When an incident opens or resolves, the worker also POSTs a small JSON payload
to the main worker (`POST /__maintenance/status-incidents`) when the shared
Worker secret `STATUS_INCIDENT_EVENT_SECRET` is set. That path fans
`status.incident.opened` / `status.incident.resolved` to admin package
subscriptions. The notify is fire-and-forget with a short timeout so a down or
missing secret cannot stall probes or email. When the secret is unset, packages
can reconcile from `GET /status.json`.

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

| Path                       | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `/`                        | Public status page (HTML)                         |
| `/status.json`             | Snapshot as JSON                                  |
| `/health`                  | Liveness for the status worker itself             |
| `/favicon-operational.png` | Favicon when all measured components are up       |
| `/favicon-down.png`        | Favicon while a kody incident is open             |
| `/favicon-unknown.png`     | Favicon when status data is unavailable           |
| `/favicon.ico`             | 302 to the current overall-status PNG (30s cache) |

The HTML `<link rel="icon">` (and apple-touch icon) is chosen from
`overallStatus` on each render. The page meta-refreshes every 60 seconds, so an
open tab picks up a new icon when an incident opens or resolves. `/favicon.ico`
follows the same snapshot so clients that ignore `<link>` tags stay in sync.
Provider incidents do not change the favicon — they stay corroborating context
only.

## Deploy

Deployed by `.github/workflows/deploy.yml` (path-filtered job, like the backup
control plane) with `npm run status:deploy`. The `CLOUDFLARE_API_TOKEN` Worker
secret (Email Sending permission) is synced at deploy time; without it, alert
emails are skipped and logged.

Wrangler attaches both `status.kody.codes` and `status.heykody.dev` as custom
domains. When `status.kody.codes` returns Cloudflare 1016, the `kody.codes` zone
still needs a `status` DNS record so that custom domain can attach. The deploy
healthcheck tries the canonical `/health` first and falls back to
`status.heykody.dev/health`; other component probes do not depend on either
hostname.
