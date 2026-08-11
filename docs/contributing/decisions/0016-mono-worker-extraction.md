# 0016: Extract the package runtime and jobs lanes into separate workers

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The `kody` worker serves every surface — Remix app, MCP, OAuth, package
apps/invocations, webhooks, remote connectors, email, maintenance, and
jobs/scheduled work — from one script hosting thirteen Durable Object classes.
That mono-worker shape concentrates deploy blast radius (every change redeploys
everything), makes the full 600+-file test suite the gate for every change, and
puts the fastest-churning, riskiest subsystem (untrusted-code execution via the
Worker Loader) in the same failure domain as login and MCP. The repo already has
two separate-worker precedents chosen for failure-domain isolation:
`packages/status/` ([0004](./0004-status-page-separate-worker.md)) and
`packages/backup-control-plane/`.

A hot-path audit preceded this decision. The chatty per-request/per-run patterns
(entitlement checks → `UserMeter`, run appends → `RunLog`, storage queries →
`StorageRunner`) are Durable Object calls, which are location-addressed and
script-independent — moving a DO class to another script does not change its
call cost. The runtime and invocation paths read/write ~15 `APP_DB` tables
directly, so forcing relational access through service-binding RPC would rebuild
half a data layer as serialized contracts. The jobs lane is the one clean data
seam: `jobs` and `archived_job_artifacts` are effectively single-owner and join
with nothing else.

## Decision

Extract two workers from the mono-worker, along failure-domain seams, deployed
independently:

1. **Package runtime worker** (`packages/runtime-worker/`): package apps,
   package invocation, and run execution. The `PackageServiceInstance`,
   `PackageRealtimeSession`, `StorageRunner`, and `RunLog` Durable Object
   classes move to this script (dashboards tolerate slower/cached RunLog reads;
   run writes originate here). It keeps direct `APP_DB` access — the security
   boundary that matters is the untrusted user code, which already runs in
   zero-binding Worker Loader isolates; the runtime host code is the same trust
   level as main.
2. **Jobs worker** (`packages/jobs-worker/`): `JobManager`, scheduled lanes, and
   job retention. It owns a **dedicated D1 database** (`kody-jobs`) holding
   `jobs` and `archived_job_artifacts`, migrated from `APP_DB` by a bounded
   manual copy. The cutover must be lossless: quiesce the scheduled lanes and
   job mutation paths (brief write pause), export, import, verify row counts and
   representative records (including archived artifacts) against the source,
   then switch reads and writes together in one deploy — never a read/write
   split across databases. `APP_DB` keeps the old tables untouched as the
   rollback path until verification passes; only a later migration drops them.
   Background write churn then leaves `APP_DB` entirely.

Everything else — Remix app, MCP, OAuth, account surfaces, email, connectors —
stays in the main worker for now; they share auth/session/D1 state too tightly
for a split to pay. Untangling MCP from the Remix app is a desired future
investigation, deliberately not part of this change.

Cross-worker calls go over Cloudflare service bindings with small,
coarse-grained, explicitly typed contracts in `packages/shared` — no chatty
per-row RPC. Table ownership is documented: post-split, `jobs` and
`archived_job_artifacts` belong to the jobs worker; a cross-worker write to
another worker's tables is a review smell. `UserMeter` stays in main and is
reachable from the extracted workers as a DO binding.

The split moves code between trust-equivalent hosts; it does not change any
isolation guarantee. Every moved surface keeps its existing authenticated user
context and owner-scoped queries (jobs, artifacts, run logs, and storage stay
keyed by user/package-derived identities, and moved DO classes keep their names
and id-derivation so instances resolve to the same objects). Migration
verification includes confirming records stay associated with the same user.
Resources staying in main (packages, secrets, values, memories, connectors,
inboxes) are untouched.

Deploys are fully independent per worker (nx-affected-narrowed CI, per-worker
SHA guards and healthchecks), following the status-worker pattern, with the
standard service-binding ordering rule: deploy the callee (with
backward-compatible changes) before the caller that depends on it. DO class
moves between scripts use Wrangler's cross-script transfer mechanism executed in
a documented runbook order — the receiving worker declares the incoming
transfer, and the source worker's deploy commits the handoff — verified on
preview deploys before production.

## Consequences

A bad runtime or jobs deploy no longer takes down login/MCP; each worker's
bundle, cold-start weight, and test gravity shrink; rollback becomes
per-subsystem. Costs: more wrangler configs to keep coherent, per-worker deploy
workflows, and cross-cutting features that span a boundary become multi-PR
affairs with ordering. The DO script migration is the one genuinely risky
one-time step and gets a runbook plus preview verification rather than a
dual-running system. If `APP_DB` becomes a bottleneck again, the next valve is
more per-user DO placement per [0002](./0002-data-placement.md), not further D1
splits — cross-database transactions do not exist, and the publish path welds
the core package tables to `APP_DB`.
