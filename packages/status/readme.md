# kody status worker

The public status page for kody, served at
[status.heykody.dev](https://status.heykody.dev). It is deliberately a separate
Cloudflare Worker with its own storage so it stays up when the main worker's
deploys, code, or database are broken (see decision record 0004).

## How it works

- A cron trigger runs one probe pass per minute against public endpoints:
  `GET /health` and `GET /health/components` on `heykody.dev`, the
  unauthenticated OAuth challenge on `/mcp`, and `kodyapps.dev`.
- A single `StatusStore` Durable Object (SQLite) stores per-minute samples (24
  h), daily uptime rollups (90 days), incidents, and sent notifications.
- A component opens an incident after two consecutive probe failures and
  resolves it after two consecutive successes.
- Operator alert emails go to `ALERT_EMAIL_TO` through the Cloudflare Email REST
  API: one email when an outage starts, at most one reminder per day while it
  lasts, one all-clear when everything has recovered, all under a daily cap
  (`STATUS_ALERT_DAILY_LIMIT`).

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
