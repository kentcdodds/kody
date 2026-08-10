# 0002: Data placement — D1, per-user Durable Objects, Analytics Engine

- **Status:** accepted
- **Date:** 2026-07-31

## Context

The single shared D1 database (`APP_DB`) is the system's scaling bottleneck:
global single-writer semantics and a 10 GB cap shared by all users. The July
2026 scalability review audited hot invocation paths and found awaited per-call
D1 writes on all of them:

- daily entitlement counter upserts on every execute call and on every sandbox
  outbound fetch;
- account-write-lease fencing — 2–5 statements on every guarded mutation via
  `withAccountWriteLease`;
- per-run activation milestone upserts
  (`packages/worker/src/run-records/package-activation-state.ts`);
- per-lifecycle `workflow_runs` projection writes;
- an uncached per-call plan read in `assertWithinEntitlement`.

Precedent for the fix already existed: run history moved to the per-user
`RunLog` Durable Object (migration `0112-drop-package-invocations.sql` dropped
`package_invocations`; `webhook_deliveries` and the `package_runtime_*` tables
were dropped the same way in `0099-drop-run-history-legacy.sql`).

The question: which storage system should each kind of data live in, so the
answer does not get re-derived (inconsistently) in every PR?

## Decision

Place data by access pattern.

**D1 (`APP_DB`)** when any of these hold:

- the data is found by something other than the owner's `userId` — login by
  email, username-based email routing, token-hash webhook ingress;
- invariants span entities or tables — the publish transaction over
  `entity_sources` + `saved_packages` + KV snapshots; secrets grants referencing
  package ids;
- it is low-write configuration read by many surfaces (cached);
- fleet-wide operational queries matter; or
- it is a cross-user enumeration/deletion index (`user_storage_buckets`,
  `mcp_agent_sessions`) — Durable Objects cannot be enumerated.

**A per-user Durable Object** when the data is high-write, always addressed by
the owner's `userId`, has owner-local invariants, and is read on the owner's own
request path: quota counters, deletion fencing, run history, activation
milestones, mailboxes, live sessions. A per-user DO converts D1's global 10 GB /
global single writer into 10 GB and a serialized writer **per user**.
Serialization is the correctness mechanism for counters and a throughput ceiling
everywhere else — do not put everything for a user behind one DO.

**Analytics Engine** when the data is append-only telemetry with reporting-grade
reads inside AE's retention window: admin insights aggregates, delivery-event
analytics, usage events. Never for request-path reads (query latency is
seconds); never for data needing retention beyond AE's window — the 180-day
audit trail goes to a separate dedicated audit D1 instead.

**Already-settled homes**, unchanged by this record: blobs in R2, OAuth provider
state and published-source snapshots in KV, vectors in Vectorize with per-user
namespaces plus `userId` metadata as defense in depth.

### The five forces behind the rubric

- **Lookup direction** — a DO is addressable only by its name; D1 rows by any
  indexed column.
- **Transactional boundaries** — DO atomicity is per-object; D1 gives
  multi-table batches.
- **Read topology** — a DO lives in one location; D1 reads can replicate and
  batch.
- **Serialization** — per-user actor ordering is a feature for quota state and a
  liability for throughput.
- **Operations** — fleet-wide SQL, shared migrations, and enumeration exist only
  in D1, so every DO move must build export/purge RPCs and any needed index.

### Externally keyed events: thin D1 reverse index

When an external callback identifies an event by a provider key instead of the
owner's `userId`, keep the owner-local payload and state machine in its per-user
DO, but maintain a thin D1 reverse index from the external key to
`(userId, owner-local id)`. The callback resolves the owner through D1, then
performs the authoritative read or mutation in that owner's DO. The
`email_outbound_provider_index` (`provider_message_id` → user/message) is the
precedent. Keep these indexes payload-free, owner-fenced, transactionally
synchronized where possible, covered by deletion, and parity-checkable.

### Standing rules

- New awaited D1 writes on hot invocation paths require a budget justification
  (extends
  [invocation overhead guardrails](../architecture/invocation-overhead-guardrails.md))
  and should first consider DO/AE placement.
- Every storage move extends account deletion/export coverage
  (`packages/worker/src/account/account-user-owned-surfaces.ts` and the
  guardrail tests) as part of the move, not as a follow-up.
- Any admin view depending on a cross-user SELECT of moved data must be
  redesigned (AE or point reads) in the same change.
- Shared storage does not relax per-user isolation. User-owned data in every
  home — packages, jobs, secrets, values, memories, remote connectors, email
  inboxes, durable storage — stays scoped by `userId` (and every Durable Object
  backing user-owned state stays namespaced by `userId`); cross-user access is
  limited to the documented operator/admin indexes and reporting aggregates. The
  full isolation contract lives in
  [data storage](../architecture/data-storage.md).

## Consequences

Concrete placements decided by the review (implemented by concurrent tracks; the
placements are the decision, independent of any track's merge state):

- **Per-user meter DO:** entitlement daily counters, `d1_storage_bytes`
  accounting, service liveness, deletion fence.
- **RunLog DO:** `workflow_runs` projection, jobs `last_run_*` observability,
  activation milestones.
- **Analytics Engine:** admin insight aggregates, delivery-event analytics,
  conversation-use signals where reporting-only.
- **Separate audit D1:** `audit_events` (180-day retention outlives AE's
  window).
- **Vectorize:** per-user namespaces, keeping the `userId` metadata filter as
  defense in depth.
- **Per-user mailbox DO** for email metadata: planned second wave.

Deliberately stays in D1: users/auth, secrets/values/integrations config,
publish pointers and package projections, community tables, jobs schedule
metadata, webhook endpoints, deletion indexes.

Costs accepted: every DO move gives up fleet-wide SQL over that data and must
ship its own export/purge RPCs plus any enumeration index it still needs;
per-user DOs introduce a serialized writer per user (a per-user throughput
ceiling to watch); expand/contract discipline means moved D1 tables stay
dual-written until production verification, with retirement migrations in
follow-ups.

Revisit if Cloudflare materially changes the constraints (multi-writer or larger
D1, DO enumeration, AE retention/latency), or if a per-user DO becomes a
measured throughput bottleneck on an owner's own request path.
