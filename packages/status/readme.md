# kody status worker

The public status page for kody, served at
[status.heykody.dev](https://status.heykody.dev). It is deliberately a separate
Cloudflare Worker with its own storage so it stays up when the main worker's
deploys, code, or database are broken (see decision record 0004).

## How it works

- A cron trigger runs one probe pass per minute against public endpoints:
  `GET /health` and `GET /health/components` on the primary origin, the
  unauthenticated OAuth challenge on `/mcp`, and the package-app apex
  (`kody.run`).
- A single `StatusStore` Durable Object (SQLite) stores per-minute samples (24
  h), daily uptime rollups (90 days), incidents, and sent notifications.
- A component opens an incident after two consecutive probe failures and
  resolves it after two consecutive successes.
- Operator alert emails go to `ALERT_EMAIL_TO` through the Cloudflare Email REST
  API: one email when an outage starts, at most one reminder per day while it
  lasts, one all-clear when everything has recovered, all under a daily cap
  (`STATUS_ALERT_DAILY_LIMIT`).

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
