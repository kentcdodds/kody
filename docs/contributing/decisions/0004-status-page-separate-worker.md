# 0004: Status page as a separate worker with its own storage

- **Status:** accepted
- **Date:** 2026-08-04

## Context

The platform needed a public status page. A status page's core job is to stay up
while the product is down, so serving it from the main `kody` worker would
defeat the point: a bad deploy, a worker-level exception, or an `APP_DB` outage
would take the status page down with the product. Third-party hosted status
services were considered and rejected as a new external vendor for a small,
self-contained need; the repo already had a second-worker precedent in
`packages/backup-control-plane/`.

## Decision

The status page is an independently deployed worker (`packages/status/`,
`status.kody.codes`) that observes the product strictly from the outside via
public endpoints (and a jobs-worker service binding, not a public jobs
hostname), and stores probe history, incidents, and notification state in its
own Durable Object — never in `APP_DB`. The main worker exposes
`GET /health/components` (cheap per-binding checks) so the prober can report
storage subsystems individually. Operator alert email goes through the
Cloudflare Email REST API under a strict policy: one email per outage episode,
one reminder per day while unresolved, one all-clear on recovery, all under a
daily cap.

Status data is global operational telemetry, not user data, so the per-user
isolation invariant is not implicated; the status worker holds no user state and
no `APP_DB` access.

## Consequences

The status page survives main-worker deploy failures, code regressions, and D1
outages, but shares Cloudflare as a platform — a full Cloudflare outage takes
both down. If that residual risk ever matters, add an external ping service on
top; do not move the status page into the main worker. The status worker
duplicates a small amount of email-sending code rather than importing from
`packages/worker` (import boundaries keep it dependency-free). Incident records
are probe-derived only; manually posted incident narratives are a possible later
addition, not built now. `status.heykody.dev` stays a worker custom domain for
legacy links and 308s to `status.kody.codes` except `/health`, which remains
reachable on the legacy host if the canonical hostname is not attached yet.
