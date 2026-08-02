# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` remain independently configured placeholders.

Module: `packages/worker/src/entitlements/`

- `plans.ts` — plan names (`free`, `pro`, `partner`, `max`), the `PlanLimits`
  config per plan, `max` email caps (`maxPlanEmailLimits`), the
  `EntitlementResource` registry, `resolvePlanLimit(plan, resource)`,
  `resolveEmailResourceLimit(plan, resource)`, `getPlanRank`, `parsePlanName`
  (strict, untrusted input), `parseStoredPlanName` (stored-column reads), and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
- `service.ts` — `getUserPlan`, `getCachedUserPlan` (60s TTL enforcement cache),
  `assertWithinEntitlement`, built-in D1 usage counters, the daily-counter
  helpers for rate-style limits, `assertWithinStorageBytesEntitlement`
  (UserMeter DO reserve with cold bootstrap), and
  `readCurrentEntitlementResourceUsage` (UserMeter-authoritative for
  `storage_bytes`, `package_services`, and daily resources).
  `countRunningPackageServices` is UserMeter-authoritative.
  `countRunningPackageServicesFromD1` is reserved for parity only.

## Plan model

The plan registry in `plans.ts` includes `free`, `pro`, `partner`, and `max`.
Every plan has finite numeric limits for every resource; there are no uncapped
tiers and no env-var backstops.

Follow-up: emergency admin-only `unlimited` is intentionally deferred until a
follow-up deployment after `0083-plan-default-free.sql` completes its residual
sweep. Until then the live registry stays finite `max` only.

`users.plan` and `invites.plan` are NOT NULL TEXT columns. Historical migrations
(`0046-invites-email-verification.sql`, `0065-invite-plans.sql`, and
`0081-plan-not-null.sql`) left the DDL default as `'unlimited'` through
`0082-rename-unlimited-plan-to-max.sql`, which renames stored `'unlimited'` rows
to `'max'` but does not change the column default. Migration
`0083-plan-default-free.sql` reconciles migration-window residual `'unlimited'`
to `'max'`, fails closed if any remain, and rebuilds both columns as NOT NULL
DEFAULT `'free'`. **Live DDL defaults and writers always persist a known plan
name (never NULL); normal creation and reset paths default to `free`.**

**Write and default:** `resolvePlanWrite` maps nullish admin/API inputs to
`free`, which is the default for new accounts, invites without an explicit plan,
admin-created accounts, platform-account provisioning, seed SQL, and admin plan
resets. Explicit `max` remains a valid deliberate assignment.

**Reading stored values:** D1 constrains `users.plan` and `invites.plan` to the
registered names. Reads use strict `parseStoredPlanName`: known names pass
through unchanged, while a value that violates the storage contract throws
without including the raw value or user data. Untrusted admin/API input uses
`parsePlanName` so typos, unknown strings, and residual `'unlimited'` are
rejected as validation failures.

`users.stripe_plan` stays nullable because it is Stripe-derived; `max` is
manual-only — admin-visible, not paid or public — and never written from Stripe
(`parseStripePlanName` rejects it, as well as residual `'unlimited'`).

`resolveEffectivePlan(manual, stripe)` compares a non-null manual plan (after
`parseStoredPlanName`) with `users.stripe_plan`. Manual `max` always wins over
Stripe; otherwise the higher-ranked of the two is returned. Unknown or null
`stripe_plan` values contribute nothing.

### `max` plan limits

The `max` plan is the operator/manual ceiling: a high finite tier admins assign
deliberately. It is not a public or Stripe-purchasable plan. Email resources use
`maxPlanEmailLimits` because inbound volume is attacker-controlled and outbound
sending is an outreach-abuse surface — use `resolveEmailResourceLimit` to read
those caps. All other resources use the ordinary `planLimits.max` numbers.

| Resource                      | Limit       |
| ----------------------------- | ----------- |
| `email_sends_per_day`         | 100         |
| `email_receives_per_day`      | 200         |
| `stored_email_messages`       | 2,000       |
| `email_message_bytes`         | 512 KiB     |
| `concurrent_workflows`        | 5,000       |
| `scheduled_jobs`              | 5,000       |
| `saved_packages`              | 10,000      |
| `package_services`            | 1,000       |
| `persistent_package_services` | 1 (allowed) |
| `repo_sessions`               | 2,000       |
| `secrets`                     | 10,000      |
| `storage_bytes`               | 100 GiB     |
| `execute_calls_per_day`       | 500,000     |
| `outbound_fetches_per_day`    | 2,000,000   |

## Compute rate limits

`execute_calls_per_day` and `outbound_fetches_per_day` are daily-counter
resources (same mechanism as `email_sends_per_day`, consumed atomically with
`consumeDailyEntitlement`). They close the metering → enforcement loop for the
two compute surfaces `usage-metering.md` already observes:

- **Execute calls** are consumed at the top of the MCP `execute` tool handler
  (`packages/worker/src/mcp/tools/execute.ts`) before any bundling or sandbox
  work, so over-limit calls cost nothing. The `EntitlementLimitError` propagates
  as a structured MCP error.
- **Outbound fetches** are consumed at the top of `executeGatewayFetch`
  (`packages/worker/src/mcp/fetch-gateway.ts`), which every sandbox fetch passes
  through, before secret expansion. `FetchGatewayProps.email` carries the acting
  user's account email for plan lookup; when a caller cannot carry one (OpenAPI
  provider requests, package runtime), the gateway reverse-resolves the account
  via `findUserAccountByStableUserId` so the caller's real plan binds. Genuinely
  accountless synthetic contexts resolve to `free` so missing identity plumbing
  cannot grant elevated quotas.

Both consume only when the context has a `userId`, matching the usage-metering
rule that events without an owning user are skipped. Daily consumption is
authoritative in the per-user `UserMeter` Durable Object; see
[UserMeter (expand phase)](#usermeter-expand-phase).

## UserMeter (expand phase)

Daily rate-style resources (`email_sends_per_day`, `email_receives_per_day`,
`execute_calls_per_day`, `outbound_fetches_per_day`) are **authoritative in the
per-user `UserMeter` Durable Object** (`USER_METER` binding). Code lives in
`packages/worker/src/entitlements/user-meter-do.ts` and `user-meter-client.ts`;
storage layout and naming are documented in [Data storage](./data-storage.md).

**D1 payload storage bytes** (`storage_bytes`) are **authoritative in
UserMeter** after the storage authority cutover (Worker #1136 passed
`USER_METER` on all email inbound/outbound storage reservations; cutover went
live 2026-08-01). `assertWithinStorageBytesEntitlement` uses atomic DO
`reserveStorageBytes` for all callers. `users.d1_storage_bytes` is a **temporary
async mirror** — it is never read for enforcement or usage after the flip; only
parity checks, reconcile tooling, and cold bootstrap read it.

**D1 package service liveness** (`package_service_states`): UserMeter is now the
**authoritative running-count source** for `package_services` enforcement and
`service_start` after the cutover (2026-08-01). D1 remains the enumeration index
for discovery, account export, and deletion, and is the parity mirror — see
[Package service liveness — UserMeter authority](#package-service-liveness--usermeter-authority-cutover-2026-08-01).

**Account-deletion write fencing** uses a split authority model after the
temporary D1 mirror was retired (2026-08-01): D1 `users.deleting_at` remains the
permanent point gate; callers that supply `USER_METER` treat UserMeter
(`authority='do'`) as authoritative for lease acquire/held/release/drain count
without any D1 row, while email/transition callers that omit `env` keep the
exact D1 `account_write_leases` path. D1 `account_write_leases` rows are now
legacy email leases and historical stale pre-retirement rows. See
[Account-deletion write fencing — UserMeter authority](#account-deletion-write-fencing--usermeter-authority-expand-phase-slice-5-phase-b).

StorageRunner bucket `estimatedBytes` and the per-bucket inventory in
`user_storage_buckets` stay a **separate** quota component. StorageRunner write
chokepoints pass `getCurrent` as a check-only composed total (DO bytes from
`readCurrentEntitlementResourceUsage(storage_bytes)` plus bucket estimates);
that path does **not** reserve bytes in UserMeter.

**Strong enforcement:** `consumeDailyEntitlement` and inbound
`consumeInboundDelivery` RPCs check the plan limit and increment inside the DO.
The Durable Object request model serializes mutations per user; counter updates
use optimistic concurrency on monotonic `revision` so concurrent consumes cannot
overshoot. Missing `(resource, day)` rows return `needs_bootstrap`; the service
then initializes that key at zero via `UserMeter.initialize()`
(`INSERT OR IGNORE`, concurrent-safe) before retrying. Warm enforcement awaits
only the DO RPC and never touches D1 daily counter state.

**D1 daily mirror retired:** consume, refund, inbound charge/read, point-read
surfaces, retention, and account export/deletion never read or write
`entitlement_daily_counters`. The three-deploy retirement is complete: Worker
`#1133` stopped mirror writes, `#1134` detached runtime inventory, and migration
`0126-drop-entitlement-daily-counters.sql` dropped the table and day index.
`admin_user_meter_parity` reports `daily.mirrorRetired: true` (meter counts
only; `d1Count`/`delta` null). Analytics Engine remains the production reporting
path for email send/receive aggregates.

**Point-read surfaces** call `readDailyEntitlementResourceUsage` (UserMeter with
the same cold zero-init path):

- Account usage UI — `packages/worker/src/app/account-usage-data.ts`
- Account email usage panel — `packages/worker/src/app/account-email-data.ts`
- `email_usage_get` MCP capability
- Admin per-user usage drill-down —
  `packages/worker/src/admin/user-usage-data.ts`

Non-daily resources still use `readEntitlementResourceUsage` against D1.
`readEntitlementResourceUsage` for daily resources and `storage_bytes` throws
and directs callers to the UserMeter helpers above.

**Inbound retry idempotency:** inbound receive quota uses
`UserMeter.consumeInboundDelivery`, which atomically claims `delivery_id` and
consumes one `email_receives_per_day` unit inside a SQLite transaction. Retries
return the accepted counter without incrementing (`replayed: true`).
Cross-UTC-day retries use the original claim's resource/day.

### D1 payload storage bytes — UserMeter authority (cutover complete)

**Production evidence:** forced rotation 2026-08-01T21:26Z; 40 scans / 40
updates / 0 failures; 38-user parity scan showed 0 storage mismatches. Mailbox
storage reservations pass `USER_METER` as of Worker #1136. Cutover is live.

**Authority after the flip:** `users.d1_storage_bytes` is a **temporary async
mirror** of the UserMeter `storage_bytes_state` singleton. It is **not** read
for enforcement or usage reads; it serves only:

- **Cold bootstrap**: when UserMeter returns `needs_bootstrap`,
  `assertWithinStorageBytesEntitlement` reads `users.d1_storage_bytes` and calls
  `UserMeter.initializeStorageBytes` (INSERT OR IGNORE, concurrent-safe), then
  retries the DO reserve.
- **Parity and tooling**: `readUserD1StorageBytes`, `admin_user_meter_parity`,
  and migration backfills compare/read the D1 mirror directly.
- **Reconcile recomputation cursor**: `listUsersForD1StorageReconciliation` uses
  `d1_storage_bytes_updated_at` as its oldest-first ordering key; the column is
  kept as the sweep cursor even though D1 is no longer authoritative.

**Do not drop `users.d1_storage_bytes` or `users.d1_storage_bytes_updated_at`
yet.** Both columns remain in place during the async-mirror dual-write window. A
separate schema migration (with its own parity sign-off) will retire them after
the reconcile lane and parity checks confirm the columns are no longer needed.

**Reserve path (`assertWithinStorageBytesEntitlement`):**

1. Resolve plan limit from `getCachedUserPlan` (60s TTL OK — only limit
   resolution is cached; DO counter is always fresh).
2. Call `UserMeter.reserveStorageBytes({ requested, limit })`.
3. If `needs_bootstrap`: read `users.d1_storage_bytes`. If the row is missing
   (synthetic context / non-account id), apply free-plan allow/deny without
   touching the DO — missing users never create a DO singleton. If the row
   exists, call `initializeStorageBytes` and retry (max 2 attempts).
4. On success: schedule best-effort non-awaited D1 mirror via `waitUntil` when
   available — `UPDATE users SET d1_storage_bytes = MAX(d1_storage_bytes, ?)`.
   The MAX guard prevents a delayed mirror from regressing D1 below a newer DO
   value. Mirror failures log `entitlement-storage-bytes-d1-mirror-failed` and
   never affect the reserve outcome.
5. On `!reserved`: throw `EntitlementLimitError`.
6. `env.USER_METER` is required on the DO-reserve path; throws immediately if
   absent (fail closed). Only the legacy `getCurrent` check-only path (used by
   StorageRunner bucket totals) omits `env` safely.

**Usage reads (`readCurrentEntitlementResourceUsage(storage_bytes)`):** Reads
from UserMeter with the same cold bootstrap path. On `needs_bootstrap`, reads
`users.d1_storage_bytes`, seeds the DO, then re-reads. The generic D1
`readEntitlementResourceUsage` for `storage_bytes` throws with guidance —
callers must use `readCurrentEntitlementResourceUsage` or
`assertWithinStorageBytesEntitlement`.

**Account export and purge:** `UserMeter.exportCounters` may return additive
non-authoritative shadow fields on the first page only (`startAfter` absent):
`storageBytesShadow` when the schema-v4 row exists, and
`packageServiceStatesShadow` when schema-v5 service rows exist. Subsequent pages
return `null` for each shadow so paged consumers never double-count them
(section totals still count each shadow inventory once when present).
`UserMeter.purge()` clears counters, inbound delivery claims, and all shadow
state (storage bytes and package-service liveness) via `deleteAll`.

### Package service liveness — UserMeter authority (cutover 2026-08-01)

**Production evidence (authority gate):** 38-user parity sweep at 2026-08-01
~21:27Z showed running-count parity clean for every user. Exactly one user had 2
D1-only stopped inventory rows with `d1-fresh-running=0` and `meter-running=0`.
No declared package services exist in production (Kent's 59 personal or 10
platform packages), so deliberate lifecycle exercise is unavailable; the parity
sweep is the production gate.

**Authority after the flip:** `countRunningPackageServices` reads directly from
the UserMeter DO — no D1 access on the enforcement path. New lifecycle
dual-writes (`upsertPackageServiceState`) populate the meter so enforcement is
immediately consistent. D1 `package_service_states` remains:

- the **enumeration index** for account export, deletion, and admin discovery
- the **parity mirror**: `admin_user_meter_parity` compares
  `countRunningPackageServicesFromD1` (D1 side) against
  `meter.countRunningPackageServices` (DO side)
- the **repair source**: `bootstrapPackageServiceStates` is an explicit
  migration/repair primitive only — it is not on the enforcement path

**Stopped inventory policy:** D1 stopped/error rows are historical inventory and
do not gate liveness authority. They are never loaded into the meter at
enforcement time. The meter count is 0 for a new user or a user with no live
dual-writes; this is correct.

**D1-only fresh-running row:** a D1 fresh-running row that has no corresponding
meter row means an older lifecycle dual-write missed the meter or a required
running projection exhausted its retries before the compensating error
projection landed. New service code does not run until its meter projection
succeeds. This remains a migration anomaly and parity blocker;
`admin_user_meter_parity` will expose it. Roll back D1 authority if this is
observed in production.

**`excludeService` and 24h staleness:** both semantics are preserved exactly.
`excludeService` is forwarded to `meter.countRunningPackageServices`. The 24h
`staleAfterMs` window applies to DO `source_updated_at` (kept fresh by heartbeat
dual-writes).

**`readEntitlementResourceUsage` throws:** calling
`readEntitlementResourceUsage(package_services)` throws with guidance directing
callers to `readCurrentEntitlementResourceUsage` or `assertWithinEntitlement`
with an explicit `getCurrent`. No production D1 count path for enforcement
remains.

**`service_start` caller:** passes `env: ctx.env` into
`countRunningPackageServices` so `USER_METER` binding is available. Missing
binding fails closed.

**Rollback window:** D1 `package_service_states` continues to receive D1-first
lifecycle dual-writes (no table/column retirements). To roll back: remove the
`readCurrentEntitlementResourceUsage` / `countRunningPackageServices` changes,
revert `service-start.ts` to call `countRunningPackageServicesFromD1`, and
restore the `readEntitlementResourceUsage` D1 path. Verify via
`admin_user_meter_parity` before rolling back.

**No declared service lifecycle:** because no package services are currently
declared in production packages, the only ongoing exercise of this path is the
heartbeat alarm and any future `service_start` calls. Parity sweeps remain the
primary verification surface.

UserMeter schema **v5** adds the per-service `package_service_states` table
inside the DO (`status`, `started_at`, monotonic `source_updated_at`,
`revision`, `updated_at`).

**Dual-write from `PackageServiceInstance`:** D1 upsert/delete runs first. A
transition that makes a service runnable requires the authoritative UserMeter
`running` upsert to succeed before service code starts. The package-service DO
makes three immediate, ordered attempts; exhausting them fails the start,
projects a non-running error state, and never launches the runtime task.
UserMeter projection remains ordered best-effort for transitions that cannot
increase usage:

- warm-start restore after upgrades (`projectServiceStateToD1`)
- running-service heartbeat alarms (1h `packageServiceStateHeartbeatMs`)
- stop, error, and idle projections that clear `running`
- purge (`deleteProjectedServiceState` deletes D1 then shadow before
  `deleteAll`)

Best-effort RPCs are optional when `USER_METER` is unbound and failures log
`package-service-user-meter-shadow-failed` without affecting the service path. A
missing binding fails a new running transition closed. UserMeter upserts reject
stale/out-of-order writes when `sourceUpdatedAt` is older than the existing row.

**Account export:** `UserMeter.exportCounters` returns additive
`packageServiceStatesShadow` on the first page only (`startAfter` absent); later
pages return `null`. The field reflects the authoritative DO inventory.

**Account purge:** `UserMeter.purge()` clears package-service shadow rows via
`deleteAll` then schema re-init.

### Account-deletion write fencing — UserMeter authority (expand phase slice 5, Phase B; mirror retired 2026-08-01)

UserMeter schema **v7** stores `account_write_leases.authority` (`do` |
`legacy`; rows created under v6 default to `legacy`) and `pending_repair_id` for
audit-safe DO repair.

**Split authority:**

- D1 `users.deleting_at` remains the **permanent point gate** (auth projection /
  purge failures fail closed). Assert-only readers (`assertAccountWritable*`)
  stay D1-only. D1 `account_write_leases` / `account_write_lease_repairs` tables
  are **not** retired; the columns and table are kept for legacy email leases,
  historical stale rows, and audit repair records.
- When `env.USER_METER` is supplied (all non-email callers), UserMeter is
  **authoritative** for lease acquire / held / release via `acquireWriteLease` /
  `assertWriteLeaseHeld` / `releaseWriteLease` (`authority='do'`). Missing
  binding or DO failures **fail closed**. No D1 row is written on acquire.
- When `env` is omitted (email/legacy), retain the **exact D1 lease path**
  (including `active_write_count`, ALS nested reuse, and `waitUntil` release).

**Temporary D1 mirror retired (2026-08-01):** the same-token dual-write of DO
leases into D1 `account_write_leases` ended after old-isolate drain. D1 rows for
DO-authority leases are now historical stale rows from before retirement; use
`admin_account_write_lease_repair` to clear them via the audited path.
`admin_user_meter_parity` reports `deletion.temporaryMirrorRetired: true`; the
`doOnly` category is expected and does not fail `mirrorLeaseParity`. Only
`legacyWithoutD1` (legacy-authority meter leases without a D1 row) and truncated
inventory fail the gate.

**`markAccountDeleting`:** always `COALESCE`s D1 `deleting_at` first, then loads
live D1 leases (legacy email rows only after mirror retirement). With `env`,
calls authoritative `markDeleting` which sets/preserves the DO tombstone,
replaces **only legacy** rows with that exact D1 snapshot, preserves
DO-authority rows, and returns the deduped-by-token union count used for drain
waits. Without `env`, returns the D1 lease count unchanged.

**Admin list / repair:** `listActiveAccountWriteLeases(db, userId, env?)` with
`env` unions live D1 leases + DO-authority leases (dedupe by token, same
`acquired_at, token` order); without `env` exact D1 behavior. DO repair is
audit-first and idempotent: prepare (stable `repairId`, lease stays held) →
insert/verify D1 audit → finalize exact pending DO repair → then idempotently
clear any stale D1 row. A stale D1 row is never cleared while the DO lease
remains held. Finalize failure without commit leaves DO held and the stale D1
row (if any) in place, and fails closed; retry resumes the pending repair. Retry
after finalize commit / lost response returns success when the matching audit
exists and the DO lease is absent (clears any stale D1 row; never falls through
to a mismatched D1 atomic batch). Post-write held checks treat pending repair as
held until finalize, then surface `AccountWriteLeaseLostError`. Pure D1 leases
keep the existing atomic audit-before-release batch.

**Account export / purge:** first-page sanitized `deletionShadow` still omits
raw token/holder. `purge()` clears leases/counters/shadows via `deleteAll` then
restores any deleting tombstone; D1 `deleting_at` remains the gate.

Public errors, ALS nested-lease reuse, holder strings, and `waitUntil` release
detachment stay parity-compatible with the pre-cutover surface.

### Package-service authority flip (complete, 2026-08-01)

The running-count authority for `package_services` moved from D1 to UserMeter as
of the cutover (see
[Package service liveness — UserMeter authority](#package-service-liveness--usermeter-authority-cutover-2026-08-01)).
D1 remains the enumeration index for account export, deletion, and admin
discovery. `countRunningPackageServicesFromD1` is retained for parity
comparisons; all enforcement uses UserMeter via `countRunningPackageServices`.

### Storage authority flip (complete, 2026-08-01)

**Production evidence:** forced rotation 2026-08-01T21:26Z; 40 scans / 40
updates / 0 failures (pre-flip shadow sweep); 38-user parity scan showed 0
storage mismatches. Worker #1136 passed `USER_METER` on all email mailbox
inbound/outbound storage reservations.

**Rollback window / dual-write:** `users.d1_storage_bytes` continues to receive
best-effort MAX mirror writes after every successful DO reservation. Physical
payload tables (not `users.d1_storage_bytes`) remain the recomputation source
for reconcile. A rollback to D1 authority is possible while the D1 mirror is
still tracking the DO counter — confirm via `admin_user_meter_parity` before
rolling back. The dual-write window closes when `users.d1_storage_bytes` and
`users.d1_storage_bytes_updated_at` are dropped (separate schema migration after
parity sign-off).

**Do not drop the D1 columns yet.** They serve as the async mirror, cold
bootstrap source, and reconcile cursor during the dual-write window.

**Current UserMeter cutover:** slice 5 Phase B moved non-email write leases into
UserMeter authority; the temporary same-token D1 rollout mirror was retired
2026-08-01 after old-isolate drain. Email keeps its D1 lease path.
Package-service authority flip remains a separate high-risk contract follow-up
after soak/parity review. Storage authority flip is complete (see above).

**Daily-counter mirror retirement (three-deploy, complete):** stage 1 (Worker
`#1133`) stopped all D1 mirror/bootstrap/retention use while leaving the
physical `entitlement_daily_counters` table in place. Stage 2 (`#1134`) detached
the runtime account export/deletion inventory target and kept a pending-drop
schema coverage exemption while the table still existed. Stage 3 (migration
`0126-drop-entitlement-daily-counters.sql`) drops the table and
`idx_entitlement_daily_counters_day`. Production `admin_user_meter_parity` scans
across 38 users showed zero daily mismatches with Analytics Engine reporting
active — the deploy rationale for stopping mirror writes before the drop. Final
live schema has no `entitlement_daily_counters` table; admin parity reports
`daily.mirrorRetired: true` (meter counts only).

### Admin UserMeter parity gates (`admin_user_meter_parity`)

Production verification for mirror retirement and remaining authority flips uses
the admin-only read-only capability `admin_user_meter_parity` (input:
`stable_user_id`). It compares production-shaped D1 rows for one account against
direct UserMeter RPCs and never bootstraps or writes parity state. After
migration `0126`, daily comparison is retired (`daily.mirrorRetired: true`): the
report returns meter counts only with `d1Count`/`delta` null and each resource
`parity: true`. Opening a cold UserMeter stub may still run Durable Object
constructor schema maintenance and opportunistic stale daily-counter pruning.
Cold meter rows surface as `needsBootstrap` with `meterCount`/`meterBytes` null.

Interpret the structured report as independent gates:

| Gate                              | Pass condition                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily counters (current UTC day)  | Final post-drop semantics (`daily.mirrorRetired: true`): report meter counts only; `d1Count`/`delta` are null, each of the four daily resources has `parity: true`, and `mismatchCount === 0` (no D1 comparison). Pre-drop Workers that still see the table compare `d1Count === meterCount` with `mirrorRetired: false`. |
| Storage bytes                     | `storage.parity` — D1 `users.d1_storage_bytes` equals UserMeter `readStorageBytes` (not `needsBootstrap`).                                                                                                                                                                                                                |
| Package services                  | `packageServices.parity` — inventory mismatch category counts are all zero (`d1Only` / `meterOnly` / `statusMismatch` / `startedAtMismatch` / `sourceUpdatedAtMismatch`), fresh-running counts match under the shared 24h stale window, and the meter page walk is not `truncated`.                                       |
| Deletion tombstone                | `deletion.deletingAtParity` — D1 `users.deleting_at` matches the meter tombstone.                                                                                                                                                                                                                                         |
| Lease readiness (post-retirement) | `deletion.mirrorLeaseParity` — `legacyWithoutD1 === 0` and inventory not truncated. `doOnly` is expected after mirror retirement and does **not** fail this gate. `d1Only` reflects legacy email leases and historical stale pre-retirement rows. `deletion.temporaryMirrorRetired` is always `true`.                     |

**D1-only (legacy) leases:** email paths that omit `env` still take exact D1
leases, so `d1Only > 0` is expected and normal. Stale pre-retirement D1 mirrors
also contribute to `d1Only` until cleared via
`admin_account_write_lease_repair`. Operators confirm legacy holders via
`admin_account_write_lease_list`.

**Threshold:** treat unexplained mismatches as blocking for the corresponding
cutover (daily mirror retirement before the drop migration, storage authority
flip, or package-service authority flip). Expected cold accounts may report
`needsBootstrap` until live traffic seeds the DO; that is a bootstrap gap, not a
silent pass. Truncated inventories fail closed (`parity` / `mirrorLeaseParity`
false) so operators re-run or raise the bounded page cap rather than approve a
partial compare.

### Post-flip storage reconciliation (`admin_user_meter_storage_reconcile`)

The admin-only maintenance capability `admin_user_meter_storage_reconcile` is a
**corrective physical-storage reconciliation** tool under UserMeter authority.
Each invocation:

1. Scans one oldest-first page (default and max `batch_size` 8) of users ordered
   by `d1_storage_bytes_updated_at`.
2. For each user: reads the current UserMeter revision **before** computing the
   physical byte count (`capturedRevision`).
3. Recomputes the absolute byte count from D1 payload tables via
   `calculateUserD1StorageBytes` (the physical source — never reads
   `users.d1_storage_bytes`).
4. Applies the result via a **revision-guarded CAS** (`reconcileStorageBytes`):
   only writes if `capturedRevision` still matches the current DO revision. This
   prevents the sweep from clobbering a live reservation that arrived between
   step 2 and the CAS call.
5. Mirrors the same absolute to `users.d1_storage_bytes` **only** after a
   successful CAS or cold init.

**Result codes:**

- `updated` — CAS applied (or cold init succeeded); UserMeter and D1 updated.
- `deferred` — CAS miss (a concurrent reserve bumped the revision) or cold-init
  race (another caller created the singleton first). The row is rotated to the
  back of the oldest-first queue for the next sweep. **A deferred row is not a
  failure.** The sweep continues; it will be retried on the next invocation once
  the meter is quiescent.
- `failed` — unexpected error; row moved to back of queue.

**CAS miss behavior:** when a live `reserveStorageBytes` call bumps the revision
between revision capture and the CAS attempt, `reconcileStorageBytes` returns
`applied: false`. The reconcile function immediately defers — it does not retry
and does not mirror to D1. The reservation byte count is fully preserved.

**Cold init race:** when the DO singleton is absent at read time
(`needs_bootstrap`), the reconcile computes the physical sum and calls
`initializeStorageBytes` (INSERT OR IGNORE). If `created: false`, another
concurrent caller already created the singleton; reconcile defers to the next
sweep without overwriting that caller's state.

Use to correct drift from deletes, failed writes, or any discrepancy between DO
counter and physical payload tables. Safe to repeat as a corrective or catch-up
sweep; not idempotent with live writes.

Module wiring: `consumeDailyEntitlement`, `refundDailyEntitlement`, and
`readDailyEntitlementResourceUsage` require `env.USER_METER` and fail closed
when the binding is missing. Storage-byte helpers
(`assertWithinStorageBytesEntitlement`, `reconcileUserD1StorageBytes`,
`readCurrentEntitlementResourceUsage` for `storage_bytes`) require `USER_METER`;
missing binding fails closed for reserve and read paths.
`readUserD1StorageBytes` is the D1 mirror reader for parity, bootstrap, and
tooling only.

## Schema history

Migration `0080-backfill-unlimited-plan.sql` backfilled pre-existing NULL
`users.plan` / `invites.plan` rows to `'unlimited'` (the former top-tier
sentinel). Migration `0081-plan-not-null.sql` reconciles any residual NULLs and
rebuilds both columns as NOT NULL DEFAULT `'unlimited'`. Migration
`0082-rename-unlimited-plan-to-max.sql` renames stored `'unlimited'` plan values
to `'max'` on `users.plan` and `invites.plan` only; it does not touch
`users.stripe_plan`, unknown plan strings, or the DDL default. Migration
`0083-plan-default-free.sql` reconciles migration-window residual `'unlimited'`
to `'max'`, fails closed if any remain, and rebuilds `users` and `invites` with
NOT NULL DEFAULT `'free'`. Migration `0113-plan-check-constraints.sql` verifies
that every stored plan is registered, then rebuilds both tables with CHECK
constraints for `free`, `partner`, `pro`, and `max`.

## Assigning plans

New accounts start with `users.plan = 'free'` unless the consumed invite carries
another plan. Migration `0065-invite-plans.sql` adds `invites.plan` (NOT NULL
DEFAULT `'free'` after `0083-plan-default-free.sql`; writers and admin UI
default to `free`). Password and social signup read the consumed invite's stored
plan with `parseStoredPlanName` and copy it onto `users.plan`; missing or
omitted invite plans are written as `free` via `resolvePlanWrite`. Admin-created
accounts, platform-account provisioning, and seed SQL follow the same
`resolvePlanWrite` default. Admins set invite plans when creating codes at
`/admin/invites` (validated with strict `parsePlanName`).

Admins also assign or reset plans on existing users through two audited,
admin-only surfaces, both backed by `updateAdminUserPlan` in
`packages/worker/src/admin/users-data.ts`:

- **Admin UI** — the "Manage plan" panel on `/admin/users` posts
  `{ action: 'update_plan', userId, plan }` to `POST /admin/users.json` (guarded
  by `update:user:any`). `plan: null` maps to `free` (writers never persist
  NULL); unknown plan strings are rejected with `400` rather than coerced.
- **MCP** — the `admin_user_update` capability (`requiredRole: 'admin'`) updates
  one user by `id` or `email` and accepts `plan: PlanName | null` (null maps to
  `free`).

Both paths validate against the plan registry (`parsePlanName` / `planNames`)
and write an `admin`-category audit event with reason `target_user_id=…;plan=…`.
Daily counters accumulate for every user regardless of plan, so assigning a
recognized plan later binds immediately against the usage already counted that
day.

Paid upgrades via Stripe write `users.stripe_plan` (not `users.plan`); see
[Billing](#billing). Effective entitlement uses the higher-ranked of the two
when a manual plan is set.

## Plan lookup

The MCP `userId` is the account's stored `users.stable_user_id` (NOT NULL,
unique index; initially from `createStableUserIdFromEmail` at signup, then
preserved across email changes). `getUserPlan(db, { userId, email })` always
returns a `PlanName`:

1. Returns `free` when `userId` is absent (no warn).
2. Returns `free` without touching D1 when `userId` is not a 64-char hex string
   (test fixtures and non-account ids).
3. When email is present: reads
   `SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`
   and returns `resolveEffectivePlan(parseStoredPlanName(plan), stripe_plan)`. A
   mismatched email/stable-id pair or missing row returns `free` (no warn).
4. When email is absent/blank: reverse-resolves
   `SELECT plan, stripe_plan FROM users WHERE stable_user_id = ?` so
   package-job, workflow, webhook, and other background contexts that persist
   `email: ''` still enforce the account's real plan. Missing rows return
   `free`.

Interactive surfaces still carry email (app sessions expose
`user.mcpUser.email`, MCP caller contexts expose
`ctx.callerContext.user.email`). Background package-runtime paths that only have
the stable userId do not need a separate email hydrate step for entitlement
checks — `getUserPlan` reverse-resolves for them.

Inbound email routing has no caller context and resolves the owning account via
the indexed username lookup (`findPublicUserIdentityByUsername`) — it does not
use stable-id reverse resolution. `findUserAccountByStableUserId` in
`service.ts` remains available for other contextless paths that need email /
verified-state (for example the outbound fetch gateway), mirroring
`findUserAccount` in `email/platform-address.ts`.

**Enforcement plan cache:** `assertWithinEntitlement` resolves the plan limit
via `getCachedUserPlan`, which wraps `getUserPlan` behind a 60-second
per-isolate TTL cache keyed by D1 binding and
`(stable_user_id, normalized email)`. Cache entries share the lookup semantics
above; failures are never cached. Built-in usage counters and any `getCurrent`
override are read fresh on every call, so only the plan limit can be stale — a
plan change may take up to ~60s to bind at enforcement points while current
usage stays accurate. Surfaces that display the user's plan (billing UI, email
usage) should keep calling `getUserPlan` directly.

## The error shape

Every enforcement point throws `EntitlementLimitError` from
`entitlements/errors.ts` and lets it propagate unchanged. Its `details` field is
the stable programmatic contract:

```ts
{
	code: 'entitlement_limit_exceeded',
	resource: EntitlementResource, // e.g. 'scheduled_jobs'
	plan: PlanName,                // always a known plan name (including `max`)
	limit: number,
	current: number,
	upgradeHint: string,
}
```

The `message` is built by `buildEntitlementLimitMessage` and is the single
user-facing string across MCP and UI surfaces:

> Plan limit reached: your "pro" plan allows at most 50 scheduled jobs and you
> currently have 50. Remove or finish existing scheduled jobs you no longer
> need, or upgrade your plan at /account/billing.

Rules:

- `details.plan` is always a known plan name; denial messages always quote that
  plan name.
- Never compose a custom denial message at an enforcement point; change the
  builder if the message needs work.
- Never catch and rewrap `EntitlementLimitError` (use `isEntitlementLimitError`
  if a surface must detect it). MCP execute results and UI handlers serialize
  `error.message`, so the message carries the full context even across Durable
  Object / RPC boundaries.

## Counting strategy

- **Row-count limits** (saved packages, scheduled jobs, repo sessions, secrets,
  running package services) are counted via built-in counters in `service.ts`.
  Most are counted directly from their source D1 tables. **Running package
  services** are now counted from the **per-user UserMeter DO** (authoritative
  as of 2026-08-01): `countRunningPackageServices` counts `status = 'running'`
  rows with the 24h staleness window from DO `source_updated_at`. D1
  `package_service_states` remains the enumeration index (discovery, export,
  deletion) and parity mirror; `countRunningPackageServicesFromD1` is retained
  for parity only — see
  [Package service liveness — UserMeter authority](#package-service-liveness--usermeter-authority-cutover-2026-08-01)
  and [Run records](./run-records.md) (`state-vs-history`). **Concurrent
  workflows** are authoritative in per-user RunLog `workflow_projections`:
  create reserves atomically via `reserveWorkflowProjectionSlot`, and usage
  readers call `countActiveWorkflowProjections` through
  `readCurrentEntitlementResourceUsage`. Expand-phase D1 `workflow_runs` is a
  compatibility mirror only.
- **Rate-style limits** (email sends/receives per day, execute calls per day,
  outbound fetches per day) are **authoritative in the per-user UserMeter
  Durable Object** (UTC day keys). Call `consumeDailyEntitlement` on every
  attempt: it resolves the plan limit, atomically checks and increments inside
  the DO, and throws `EntitlementLimitError` when over limit. Every resolved
  plan has a finite numeric limit. Counting attempts rather than successes keeps
  the limit abuse-resistant for permanent rejects (parse failures,
  entitlement/quota rejects).

  **Cold bootstrap:** missing `(resource, day)` rows trigger
  `UserMeter.initialize({ count: 0 })` (`INSERT OR IGNORE`) before retrying the
  consume. Concurrent cold callers cannot double-apply a non-zero baseline.

  **D1 mirror retired:** consume/refund/inbound charge/read paths never touch
  `entitlement_daily_counters`; migration `0126` dropped the table.

  A delivery claim remains charged when later storage fails. Cloudflare Email
  Routing retries replay that same `delivery_id` through
  `UserMeter.consumeInboundDelivery` without incrementing again, including
  across a UTC-day boundary. The retained claim is the idempotency boundary;
  production inbound handling does not call `refundDailyEntitlement`.

- **Boolean allowances** (persistent package services) are modeled as limit `0`
  (not allowed) vs `1` (allowed) so the numeric contract stays uniform.
- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- **Storage-byte limits** (`storage_bytes`) split into two quota components:
  1. **D1 payload bytes (authoritative in UserMeter after flip):** user-owned D1
     rows with durable payloads (`email_messages.raw_size` plus extracted
     message bodies/metadata, externally stored attachments, values, encrypted
     secrets, memories, saved-package projections, jobs, repo/session metadata,
     package invocation results, and published artifact metadata). Run records
     in the per-user `RunLog` Durable Object are intentionally **excluded** —
     they are observability history, not user content. Write chokepoints
     atomically reserve positive byte deltas via
     `assertWithinStorageBytesEntitlement` against the UserMeter DO (every
     caller, including email, after Worker #1136). Cold DO singletons bootstrap
     from `users.d1_storage_bytes` (INSERT OR IGNORE, concurrent-safe) before
     retrying the reserve. After a successful DO reserve, a best-effort MAX
     mirror is scheduled to `users.d1_storage_bytes` via `waitUntil`. The
     bounded `d1_storage_reconciliation` lane recomputes the physical
     cross-surface sum via `calculateUserD1StorageBytes`, applies it to
     UserMeter via a revision-guarded CAS (never clobbers a live reservation),
     then mirrors to D1 only after a successful CAS or cold init — see
     [UserMeter (expand phase)](#usermeter-expand-phase).

  2. **StorageRunner bucket estimates (separate):** each bucket exposes
     `estimatedBytes`; inventory rows persist the latest measurement on
     `user_storage_buckets.estimated_bytes` (migration 0118). Write chokepoints
     that pass `getCurrent` compose
     `D1 payload (readUserD1StorageBytes) + sum of per-bucket estimates` for a
     **check-only** entitlement comparison — `getCurrent` never reserves in D1
     or UserMeter. Only the bucket that triggers the baseline read (plus any
     inventoried bucket with no stored estimate yet) is probed live; every other
     bucket contributes its stored D1 estimate, so mutating writes do not fan
     `getEstimatedBytes` RPCs across the whole inventory. Live probe results are
     persisted fire-and-forget with **UPDATE-only** statements (they can never
     recreate an inventory row removed by account, package, or job deletion),
     and mutating StorageRunner RPCs opportunistically refresh their own
     bucket's stored estimate after the write, throttled per bucket per isolate
     (`storageBucketEstimateRefreshMinIntervalMs`). Stored estimates are
     freshness hints with bounded lag — acceptable for an order-of-magnitude cap
     because the bucket paying the baseline read is measured live and the run
     cache accounts for the run's own accepted writes. `requested` is the
     candidate payload size when known. Pure read-only `storage.sql` /
     `packageStorage().sql` statements (`SELECT` / `EXPLAIN` / schema `PRAGMA`)
     skip the baseline read entirely even when the helper marks the call
     writable. Mutating SQL and `storage.set` in one sandbox share a per-run
     baseline cache so repeated writes do not re-read the baseline; a later
     write in the same run that targets a **different** already-inventoried
     bucket reuses that bucket's stored estimate rather than probing it live
     (bounded staleness, same trade-off as peers). Each live estimate read waits
     at most ~2s via `Promise.race` and is retried with backoff
     (`storageEstimateReadRetryDelaysMs`; a single 150ms retry lost to transient
     per-bucket DO read failures in production) before failing closed for the
     caller; the underlying DO RPC is not cancelled if the runtime keeps it
     running. A cron lane (`storage_bucket_estimate_backfill`,
     `packages/worker/src/storage-buckets/estimate-backfill.ts`) sweeps
     inventory rows without a stored estimate in bounded batches (failed probes
     stay unmeasured and are retried on later sweeps) so freshly migrated
     inventories converge to stored estimates within a few ticks instead of
     making each user's first mutating write pay (and possibly fail on) the
     whole-inventory probe. The D1 payload counter intentionally does **not**
     attempt to scan Cloudflare Artifacts repository contents, KV
     snapshot/bundle bodies, R2 object listings beyond
     `email_messages.raw_size`, or Vectorize: those stores either lack reliable
     byte metadata or are derived from D1 and are documented in
     `data-storage.md`.

### Concurrency

Row-count limits are check-then-insert: the count query and the later insert are
separate statements, so a burst of concurrent creates can overshoot a limit by a
few rows before the next check sees the new count. That is an accepted trade-off
— these limits are order-of-magnitude denial-of-wallet caps, not billing-grade
accounting, and folding every insert into a conditional statement would couple
the entitlements module to each resource's write path. Daily rate-style limits
do not share this window: UserMeter consumes are serialized per user inside the
DO with revision-checked updates.

## How to add an enforcement point

The exemplar is job scheduling: `createJob` in
`packages/worker/src/jobs/service.ts`.

1. Find the service-layer function that **creates** the resource (enforce on
   creation, not updates), as early as possible — before any side effects like
   entity-source creation.
2. Make sure the acting user's `userId` **and** account email reach that
   function. Thread an explicit `userEmail` parameter if the service only
   receives only `userId`; MCP capabilities get it from
   `requireMcpUser(ctx.callerContext).email`, app handlers from the session
   user.
3. Call the single helper and let it throw:

```ts
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'

await assertWithinEntitlement({
	db: env.APP_DB,
	userId,
	email: userEmail,
	resource: 'scheduled_jobs',
})
```

Use `getCurrent` only when the built-in D1 counter cannot express the resource.

4. If the resource is a new one, register it in `plans.ts`
   (`entitlementResources`, `PlanLimits`, `planLimits`,
   `entitlementResourceLabels`, `resolvePlanLimit`) and add a built-in counter
   in `service.ts` when it is D1-countable.
5. Test both sides: a plan user at the limit is denied with
   `details.code === 'entitlement_limit_exceeded'` (assert `resource`, `plan`,
   `limit`, `current`). Build the test user's id with
   `createStableUserIdFromEmail(email)` (or any stored `stable_user_id`) and
   assert plan lookup against the email + stable-id pair; a mismatched pair must
   resolve as `max`.

## Enforcement points

| Resource                      | Enforcement point                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                                                                                                                                                                            |
| `saved_packages`              | new-package branch of `package_save` and projection insert                                                                                                                                                                                 |
| `package_services`            | `service_start` capability path (`getCurrent` with `countRunningPackageServices(env)`; UserMeter authority since 2026-08-01; D1-only fresh-running rows are parity blockers rather than runtime bootstrap input)                           |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                                                                                                                                                                                 |
| `repo_sessions`               | `repo_open_session` before creating a new session                                                                                                                                                                                          |
| `email_sends_per_day`         | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`)                                                                                                                                                        |
| `email_receives_per_day`      | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)                                                                                                                          |
| `stored_email_messages`       | `handleInboundEmail` before storage (`assertWithinEntitlement`; `max` caps from `planLimits.max`)                                                                                                                                          |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size via `resolveEmailResourceLimit`)                                                                                                                                             |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                                                                                                                           |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (`reserveWorkflowProjectionSlot` + `assertWithinEntitlement` getCurrent; `max` = 5,000)                                                                                                                    |
| `storage_bytes`               | UserMeter DO reserve via `assertWithinStorageBytesEntitlement` (atomic `reserveStorageBytes`; cold bootstrap from D1 mirror; required `env.USER_METER`); StorageRunner write tools/app RPCs (`getCurrent` check-only for bucket component) |

## Billing

Optional Stripe subscription billing lives in `packages/worker/src/billing/`
(raw `fetch` client — no Stripe SDK; `STRIPE_API_BASE_URL` overrides the API
host for tests/mocks). Without `STRIPE_SECRET_KEY`, billing surfaces degrade to
manual plans only.

Checkout sessions are created server-side for authenticated users via
`POST /account/billing/checkout.json` (Stripe Checkout Session,
`mode=subscription`, with a signed `client_reference_id` and
`metadata.kody_stable_user_id`). There is no public Payment Link path — checkout
requires a signed-in session so unauthenticated card-testing is not possible.
`GET /account/billing/success` verifies `client_reference_id` before linking
`users.stripe_customer_id`, then refreshes `users.stripe_plan`.
`GET /account/billing/portal` opens the Stripe customer portal for linked
customers.

### Webhooks (primary sync)

`POST /webhooks/stripe` is the primary path for linking customers and refreshing
plans when Stripe subscription state changes. It is unauthenticated and verifies
the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256 over
`${t}.${rawBody}`; ~300s timestamp tolerance). When the secret is unset, the
endpoint returns 503.

Handled event types:

- `checkout.session.completed` — resolve the user via `client_reference_id`
  matching `createBillingLinkReference` (candidates from
  `metadata.kody_stable_user_id`, existing `stripe_customer_id`, or customer
  email), then run the same link+refresh helper as the success redirect
- `customer.subscription.updated` / `customer.subscription.deleted` — look up
  the user by `users.stripe_customer_id` and call `refreshStripePlanForUser`
- `invoice.payment_failed` — same customer lookup + refresh (surfaces
  `subscriptionStatus` such as `past_due` for UX; does not email users)
- Unknown event types — acknowledge `200` after process+record

Idempotency uses migration `0093-stripe-webhook-events.sql`
(`stripe_webhook_events.event_id` unique). Events are processed first (handlers
are idempotent), then recorded. A UNIQUE conflict after a successful process is
treated as duplicate success (`200`). Process failures return `500` without
inserting so Stripe can retry. Rows older than 30 days are pruned by retention.

### Activity-driven backup

The global hourly customer scan is retired. Checkout completion and
subscription/invoice webhooks refresh immediately and also arm the owning user's
one-shot `StripePlanRefresh` Durable Object alarm for one hour later. That
independent retry closes over transient Stripe failures without repeatedly
enumerating inactive users. `/account/billing` arms the same backstop and still
refreshes on every view so non-persisted `cancel_at` / `subscriptionStatus` stay
current. If checkout cannot arm its backstop, a failed immediate refresh remains
an error so the caller or Stripe webhook retries instead of acknowledging an
unrecoverable stale projection. Migration `0066-stripe-billing.sql` adds
`stripe_customer_id` (unique partial index), `stripe_plan`, and
`stripe_plan_refreshed_at`; Wrangler migration `v23` adds the alarm DO class
without moving canonical billing data out of D1.

Published prices: Free $0, Pro $5/mo. Env vars and deploy wiring are documented
in [`../environment-variables.md`](../environment-variables.md).

## Related tables and coordination

- `users.plan` — added by the invite-signup migration
  (`0046-invites-email-verification.sql`); NOT NULL DEFAULT `'free'` after
  `0083-plan-default-free.sql` (writers default to `free`). The entitlements
  module is the consumer of that column (manual / invite / admin grant).
- `invites.plan` — signup plan from migration `0065-invite-plans.sql`; NOT NULL
  DEFAULT `'free'` after `0083-plan-default-free.sql` (writers and admin UI
  default to `free`). Applied to `users.plan` when the invite is consumed at
  signup via `parseStoredPlanName` and `resolvePlanWrite`.
- `users.stripe_customer_id`, `users.stripe_plan`,
  `users.stripe_plan_refreshed_at` — Stripe billing columns from migration
  `0066-stripe-billing.sql`; owned by `packages/worker/src/billing/`, read by
  `getUserPlan` via `resolveEffectivePlan`. `stripe_plan` stays nullable because
  it is Stripe-derived; `max` is manual-only.
- `entitlement_daily_counters` — **retired**. Created by migration
  `0048-user-plans-and-entitlement-counters.sql`, indexed by
  `0055-retention-indexes.sql`, and dropped by
  `0126-drop-entitlement-daily-counters.sql` after stages 1/2 stopped mirror
  writes and detached runtime inventory. Final live schema has no table or day
  index; `admin_user_meter_parity` reports `daily.mirrorRetired: true`. Daily
  counters are authoritative in the per-user `UserMeter` DO; account export uses
  UserMeter RPCs.
