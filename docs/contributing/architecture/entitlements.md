# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` stay independently configured from Stripe list prices.

Module: `packages/worker/src/entitlements/` plus the client-safe plan registry
at `packages/worker/universal/plans.ts`.

- `plans.ts` (`#universal/plans.ts`) — plan names (`free`, `standard`, `pro`,
  `max`), the `PlanLimits` config per plan, `max` email caps
  (`maxPlanEmailLimits`), the `EntitlementResource` registry,
  `resolvePlanLimit(plan, resource)`, `getPlanRank`, `parsePlanName` (strict,
  untrusted input), `parseStoredPlanName` (stored-column reads), and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
- `service.ts` — `getUserPlan`, `getCachedUserPlan` (60s TTL enforcement cache),
  `assertWithinEntitlement`, built-in D1 usage counters, the daily-counter
  helpers for rate-style limits, `assertWithinStorageBytesEntitlement`
  (UserMeter DO reserve with cold bootstrap), and
  `readCurrentEntitlementResourceUsage` (UserMeter-authoritative for
  `storage_bytes` and daily resources).

## Plan model

The plan registry in `plans.ts` includes `free`, `standard`, `pro`, and `max`.
Every plan has finite numeric limits for every resource; there are no uncapped
tiers and no env-var backstops.

There is deliberately no uncapped plan; the live registry stays finite `max`
only.

`users.plan` and `invites.plan` are NOT NULL TEXT columns with DDL default
`'free'` and CHECK constraints for the registered names (squashed baseline plus
`0002-restructure-plan-tiers.sql`). **Live DDL defaults and writers always
persist a known plan name (never NULL); normal creation and reset paths default
to `free`.**

**Write and default:** `resolvePlanWrite` maps nullish admin/API inputs to
`free`, which is the default for new accounts, invites without an explicit plan,
admin-created accounts, platform-account provisioning, seed SQL, and admin plan
resets. Explicit `max` remains a valid deliberate assignment.

**Reading stored values:** D1 constrains `users.plan` and `invites.plan` to the
registered names. Reads use strict `parseStoredPlanName`: known names pass
through unchanged, while a value that violates the storage contract throws
without including the raw value or user data. Untrusted admin/API input uses
`parsePlanName` so typos, unknown strings, and retired plan names are rejected
as validation failures.

Migration `0002-restructure-plan-tiers.sql` maps stored `pro` values to
`standard`, stored `partner` values to `pro`, and rebuilds both CHECK
constraints for the current registry.

`users.stripe_plan` stays nullable because it is Stripe-derived; `max` is
manual-only — admin-visible, not paid or public — and never written from Stripe
(`parseStripePlanName` rejects it, along with any retired or unknown name).

`resolveEffectivePlan(manual, stripe)` compares a non-null manual plan (after
`parseStoredPlanName`) with `users.stripe_plan`. Manual `max` always wins over
Stripe; otherwise the higher-ranked of the two is returned. Unknown or null
`stripe_plan` values contribute nothing. Admin user list/get (page and MCP)
expose the grant, Stripe tier, effective plan, and whether a Stripe customer is
linked. `plan` on those records remains the grant that Manage plan edits.

### `max` plan limits

The `max` plan is the operator/manual ceiling: a high finite tier admins assign
deliberately. It is not a public or Stripe-purchasable plan. Email resources use
`maxPlanEmailLimits` because inbound volume is attacker-controlled and outbound
sending is an outreach-abuse surface — `resolvePlanLimit` resolves those caps
like any other limit. The caps stay finite but dominate every other plan's email
limits, so granting `max` never reduces email capacity (`email_message_bytes`
stays at standard/pro parity because the per-message persist ceiling is a
platform bound, not a scalable quota). Compute rate limits on `max`
(`execute_calls_per_day`, `outbound_fetches_per_day`, `job_runs_per_day`,
`concurrent_workflows`) are operator runaway caps sized from production usage
with at least 2× busy-day headroom, and they still dominate every paid plan. All
other resources use the ordinary `planLimits.max` numbers.

| Resource                   | Limit   |
| -------------------------- | ------- |
| `email_sends_per_day`      | 10,000  |
| `email_receives_per_day`   | 20,000  |
| `stored_email_messages`    | 100,000 |
| `email_message_bytes`      | 768 KiB |
| `concurrent_workflows`     | 200     |
| `scheduled_jobs`           | 5,000   |
| `saved_packages`           | 10,000  |
| `repo_sessions`            | 20,000  |
| `secrets`                  | 10,000  |
| `storage_bytes`            | 100 GiB |
| `execute_calls_per_day`    | 25,000  |
| `outbound_fetches_per_day` | 80,000  |
| `job_runs_per_day`         | 40,000  |

## Compute rate limits

`execute_calls_per_day`, `outbound_fetches_per_day`, and `job_runs_per_day` are
daily-counter resources (same mechanism as `email_sends_per_day`, consumed
atomically with `consumeDailyEntitlement`). They close the metering →
enforcement loop for the compute surfaces `usage-metering.md` already observes:

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
  cannot grant elevated quotas. Server-side fetches of a user-supplied URL go
  through the same gateway rather than global `fetch` — including OpenAPI spec
  documents (`packages/worker/src/openapi/fetch-spec.ts`), where each redirect
  hop is its own gateway fetch.
- **Job runs** are consumed at the top of `executeJobOnce`
  (`packages/worker/src/jobs/service.ts`) after caller-context resolution and
  before sandbox work, so over-limit ticks fail cheaply. This is separate from
  `scheduled_jobs` (how many job rows an account may own).
- **Job interval floor** (`planLimits.*.minJobIntervalMs`) applies only to free:
  recurring jobs cannot run more often than every 15 minutes. The floor is
  asserted on create and on an actual schedule change (`JobIntervalFloorError`).
  Identity-only refreshes of an existing faster job are grandfathered. Paid
  plans have no extra floor.

These consume only when the context has a `userId`, matching the usage-metering
rule that events without an owning user are skipped. Daily consumption is
authoritative in the per-user `UserMeter` Durable Object; see
[UserMeter](#usermeter).

## UserMeter

Daily rate-style resources (`email_sends_per_day`, `email_receives_per_day`,
`execute_calls_per_day`, `outbound_fetches_per_day`, `job_runs_per_day`) are
**authoritative in the per-user `UserMeter` Durable Object** (`USER_METER`
binding). Code lives in `packages/worker/src/entitlements/user-meter-do.ts` and
`user-meter-client.ts`; storage layout and naming are documented in
[Data storage](./data-storage.md). UserMeter also stores first-seen Dynamic
Worker ids per UTC day so usage metering can record `dynamic_worker_day` without
double-counting; that table is cost attribution, not a plan cap. See
[Usage metering](./usage-metering.md).

**D1 payload storage bytes** (`storage_bytes`) are **authoritative in
UserMeter**. `assertWithinStorageBytesEntitlement` uses atomic DO
`reserveStorageBytes` for all callers. Cold bootstrap zero-initializes the DO
singleton (matching the daily counter cold path); the bounded
`d1_storage_reconciliation` lane recomputes physical D1 payload bytes and
corrects drift via revision-guarded CAS, sweeping users by `stable_user_id`
keyset from the platform-owned `d1_storage_reconcile_cursor` row.

**Account-deletion write fencing:** D1 `users.deleting_at` remains the permanent
point gate. All callers (including email paths) supply `env`; UserMeter is
authoritative for all lease acquire/held/release/count operations. D1
`account_write_lease_repairs` is the repair audit log. See
[Account-deletion write fencing](#account-deletion-write-fencing).

StorageRunner and RepoSession `estimatedBytes` values and their per-bucket
inventory in `user_storage_buckets` stay a **separate** quota component.
StorageRunner write chokepoints pass `getCurrent` as a check-only composed total
(DO bytes from `readCurrentEntitlementResourceUsage(storage_bytes)` plus all
inventoried bucket estimates); that path does **not** reserve bytes in
UserMeter.

**Strong enforcement:** `consumeDailyEntitlement` and inbound
`consumeInboundDelivery` RPCs check the plan limit and increment inside the DO.
The Durable Object request model serializes mutations per user; counter updates
use optimistic concurrency on monotonic `revision` so concurrent consumes cannot
overshoot. Missing `(resource, day)` rows return `needs_bootstrap`; the service
then initializes that key at zero via `UserMeter.initialize()`
(`INSERT OR IGNORE`, concurrent-safe) before retrying. Warm enforcement awaits
only the DO RPC and never touches D1 daily counter state.

**Daily counter authority:** consume, refund, inbound charge/read, point-read
surfaces, retention, and account export/deletion use `UserMeter`; D1 has no
daily entitlement counter table or day index. `adminUserMeterParity` reports
meter-only daily counts (no D1 comparison fields exist). Analytics Engine
remains the production reporting path for email send/receive aggregates.

**Point-read surfaces** call `readDailyEntitlementResourceUsage` (UserMeter with
the same cold zero-init path):

- Account usage UI — `packages/worker/src/app/account-usage-data.ts`
- Account email usage panel — `packages/worker/src/app/account-email-data.ts`
- `usageGet` MCP capability
- Admin per-user usage drill-down —
  `packages/worker/src/admin/user-usage-data.ts` (via
  `readAdminEntitlementConsumption` in
  `packages/worker/src/admin/entitlement-consumption.ts`, including
  `storage_bytes` from UserMeter)
- Admin fleet entitlement-pressure panel and `usage_entitlement_alert` lane —
  same `readAdminEntitlementConsumption` helper over a bounded sweep of the top
  ~15 active users by current-month event count. The lane emits one
  `fleet.entitlement.crossed` event per 80% or 100% crossing (and per first
  over-threshold runtime-duration month, unique Dynamic Worker cost month, or
  three-of-seven execute-cap train) to admin-owned packages. Staying over the
  same threshold does not emit again; dropping below and climbing back is a new
  instance. KV prefix `fleet-entitlement-crossing:v1` stores
  `{prefix}:{userId}:entitlement:{threshold}:{resource}` for stock limits,
  appends the UTC day for `*_per_day` counters, uses
  `{prefix}:{userId}:runtime_duration:{month}` for the 24h runtime signal,
  `{prefix}:{userId}:dynamic_worker_cost:{month}` for the unique-worker cost
  signal, and `{prefix}:{userId}:repeated_entitlement:{resource}` for the
  execute-cap train. Hit days live under `fleet-entitlement-hit:v1`.
- User entitlement warning emails (same hourly lane) — emails verified person
  accounts when usage crosses 80% or 100% of their effective plan (transactional
  template). Throttle is one mail per crossing of a given percentage on a
  specific entitlement: staying at 10/10 packages does not mail again the next
  UTC day. Dropping below that threshold and climbing back over it is a new
  instance. Same-hour crossings of the same kind batch into one mail. KV prefix
  `entitlement-warning-user:v3` stores `{prefix}:{userId}:{kind}:{resource}` for
  stock limits, and appends the UTC day for `*_per_day` counters so a midnight
  reset is a new instance. Stock claims use a 30-day TTL that the hourly sweep
  refreshes while the user is over, so sitting at a cap stays silent and a later
  drop out of the candidate set can rematch after the claim expires. Daily
  claims keep a 36-hour TTL. Claim reads also honor same-day `v2` daily keys
  (one claim for every resource in that kind's bucket). A `v2` key from a prior
  UTC day claims stock limits only, so a `*_per_day` midnight reset can mail.
  Candidate selection is the top ~80 accounts by current-month event count plus
  high package/secret stock, capped at 100. Operator crossing events run even
  when user warning sends fail.

`readEntitlementResourceUsage` counts only APP_DB-backed row resources (`repos`,
`saved_packages`, `secrets`). Resources whose authority is elsewhere
(`scheduled_jobs` via `jobsData`, `repo_sessions` via `RepoSessionIndex`, daily
counters via UserMeter, `stored_email_messages` via Mailbox,
`concurrent_workflows` via RunLog, `storage_bytes` via UserMeter, and
`email_message_bytes` via caller `getCurrent`) throw from that helper and must
use `readCurrentEntitlementResourceUsage` or an explicit `getCurrent` callback.

**Inbound retry idempotency:** inbound receive quota uses
`UserMeter.consumeInboundDelivery`, which atomically claims `delivery_id` and
consumes one `email_receives_per_day` unit inside a SQLite transaction. Retries
return the accepted counter without incrementing (`replayed: true`).
Cross-UTC-day retries use the original claim's resource/day.

### D1 payload storage bytes — UserMeter authority

**Authority:** the UserMeter `storage_bytes_state` singleton is the sole
enforcement and usage counter. The reconcile lane walks users by
`stable_user_id` keyset from the platform-owned `d1_storage_reconcile_cursor`
singleton (advanced once per processed page, wrapping at the tail).

**Reserve path (`assertWithinStorageBytesEntitlement`):**

1. Resolve plan limit from `getCachedUserPlan` (60s TTL OK — only limit
   resolution is cached; DO counter is always fresh).
2. Call `UserMeter.reserveStorageBytes({ requested, limit })`.
3. If `needs_bootstrap`: probe for a `users` row. If the row is missing
   (synthetic context / non-account id), apply free-plan allow/deny without
   touching the DO — missing users never create a DO singleton. If the row
   exists, zero-initialize via `initializeStorageBytes` (INSERT OR IGNORE,
   concurrent-safe, matching the daily counter cold path) and retry (max 2
   attempts). The reconcile lane corrects the counter from physical payload
   bytes.
4. On `!reserved`: throw `EntitlementLimitError`.
5. `env.USER_METER` is required on the DO-reserve path; throws immediately if
   absent (fail closed). The StorageRunner check-only path (bucket totals via
   `getCurrent`) omits `env` safely.

**Usage reads (`readCurrentEntitlementResourceUsage(storage_bytes)`):** Reads
from UserMeter with the same zero-init cold bootstrap path. The generic D1
`readEntitlementResourceUsage` for `storage_bytes` throws with guidance —
callers must use `readCurrentEntitlementResourceUsage` or
`assertWithinStorageBytesEntitlement`. StorageRunner's composed baseline also
reads UserMeter via `readStorageBytesFromUserMeter`.

**Account export and purge:** `UserMeter.exportCounters` returns authoritative
`storageBytesState` and sanitized `deletionState` on the first page only
(`startAfter` absent). Subsequent pages return `null` for each so paged
consumers never double-count them. `UserMeter.purge()` clears counters, inbound
delivery claims, storage state, and write leases via `deleteAll`, then restores
an existing deletion tombstone so in-flight cleanup stays fenced. After the D1
`users` row is deleted, origin calls `clearUserMeterDeletionTombstone` so the
next signup with the same email (same SHA-256 `stable_user_id`) can acquire
write leases. A live D1 row that collides with a leftover DO tombstone also
clears that tombstone on the next `withAccountWriteLease` acquire.

### Account-deletion write fencing

UserMeter schema **v8** stores `account_write_leases` with `token`, `holder`,
`acquired_at`, and `pending_repair_id`.

**Authority:** D1 `users.deleting_at` remains the **permanent point gate** (auth
projection / purge failures fail closed). All callers supply `env`; UserMeter is
authoritative for lease acquire / held / release / count via `acquireWriteLease`
/ `assertWriteLeaseHeld` / `releaseWriteLease` / `countActiveWriteLeases`.
Missing `USER_METER` binding **fails closed**. D1 `account_write_lease_repairs`
is the audit log for repairs. ALS nested-lease reuse propagates per
`stableUserId` across the async call chain. MCP `/mcp` takes the full UserMeter
write lease only for mutating JSON-RPC (`tools/call` other than `search`,
batches that include a write, and unclassified bodies); read-only methods
(`initialize`, `tools/list`, `ping`, and `search`) check D1 `users.deleting_at`
only so a deleting account still gets `409 account_deleting` without the acquire
/ held / release RPCs.

**`markAccountDeleting`:** `COALESCE`s D1 `deleting_at` (idempotent), then calls
`markDeleting` on the DO (sets/preserves the tombstone). Returns the active DO
lease count for drain waits. If the DO call fails and D1 did not already have a
tombstone, the D1 fence is rolled back.

**`abortAccountDeleting`:** used when deletion fails before cleanup (active
writes or incomplete inventory) **and this invocation created the fence**.
Automatic abort passes `expectedDeletingAt` so D1 and
`UserMeter.clearDeleting()` only drop a matching tombstone. Cleanup failures and
retries against an already-fenced account keep the tombstone so a retry can
finish. Operators restore a leftover fence with `adminAccountDeletionAbort`
(stable user id + audit reason), which resolves `users.id` internally.

**Admin list / repair:** `listActiveAccountWriteLeases(env, userId)` reads DO
leases via `listWriteLeases` pages — no D1 union. Repair is DO-only and
audit-first: prepare (stable `repairId`, lease stays held) → insert/verify D1
audit row → finalize exact pending DO repair. Finalize failure leaves DO held
and fails closed; retry resumes from the existing audit row. Retry after a lost
finalize response returns success when the matching audit exists and the DO
lease is absent. Wrong user, stale `acquiredAt`, or short reason requests fail
closed.

**Account export / purge:** first-page sanitized `deletionState` omits raw
token/holder (count and `acquiredAt` only). `purge()` clears leases and counters
via `deleteAll` then restores any deleting tombstone while the D1 user row still
exists. After that row is deleted, origin drops the restored tombstone so a
later account with the same email-derived `stable_user_id` is writable. Live D1
plus a leftover meter tombstone heals on the next write-lease acquire (D1 is
re-checked before the clear so an in-progress deletion keeps its fence, and
again after the clear so a deletion that started in that window restores the
tombstone and fails closed). D1 `deleting_at` remains the gate. Post-write held
checks treat pending repair as held until finalize, then surface
`AccountWriteLeaseLostError`.

**Current UserMeter authority:** all write leases (including email) and storage
bytes are authoritative in UserMeter. See the storage and write-fencing sections
above.

**Daily-counter authority:** UserMeter is the only daily-counter store. Admin
parity reports meter-only daily counts; Analytics Engine remains the reporting
store.

### Admin UserMeter parity gates (`adminUserMeterParity`)

Production verification uses the admin-only read-only capability
`adminUserMeterParity` (input: `stable_user_id`). It compares physical D1
payload bytes and the permanent D1 deletion tombstone with direct UserMeter
RPCs. It never writes parity state. The daily section is meter-only. Opening a
cold UserMeter stub may still run Durable Object constructor schema maintenance
and opportunistic stale daily-counter pruning. Cold meter rows surface as
`needsBootstrap` with `meterCount`/`meterBytes` null.

Interpret the structured report as independent gates:

| Gate                     | Pass condition                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily counters (UTC day) | Meter-only reads: each daily resource reports `meterCount` (null with `needsBootstrap: true` on cold accounts).                                                               |
| Storage bytes            | `storage.parity` — physical D1 payload recompute (`calculateUserD1StorageBytes`) equals UserMeter `readStorageBytes` and the meter does not need bootstrap.                   |
| Deletion tombstone       | `deletion.deletingAtParity` — D1 `users.deleting_at` matches the meter tombstone.                                                                                             |
| Active lease count       | `deletion.activeLeaseCount` — count of authoritative UserMeter write leases. Alert on unexplained non-zero counts after known writer processes have been verified terminated. |

Treat unexplained storage or deletion mismatches as failures. Expected cold
accounts may report `needsBootstrap` until live traffic seeds the DO; that is a
bootstrap gap, not a silent pass.

### Storage reconciliation (`adminUserMeterStorageReconcile`)

The admin-only maintenance capability `adminUserMeterStorageReconcile` is a
**corrective physical-storage reconciliation** tool under UserMeter authority.
Each invocation:

1. Scans one keyset page (default and max `batch_size` 8) of users ordered by
   `stable_user_id`, starting after the platform-owned
   `d1_storage_reconcile_cursor` position and wrapping at the tail.
2. For each user: reads the current UserMeter revision **before** computing the
   physical byte count (`capturedRevision`).
3. Recomputes the absolute byte count from D1 payload tables via
   `calculateUserD1StorageBytes` (the physical source).
4. Applies the result via a **revision-guarded CAS** (`reconcileStorageBytes`):
   only writes if `capturedRevision` still matches the current DO revision. This
   prevents the sweep from clobbering a live reservation that arrived between
   step 2 and the CAS call.
5. Advances the keyset cursor past the processed page; no byte values are
   written to D1.

**Result codes:**

- `updated` — CAS applied (or cold init succeeded); UserMeter updated.
- `deferred` — CAS miss (a concurrent reserve bumped the revision) or cold-init
  race (another caller created the singleton first). The row is rotated to the
  back of the oldest-first queue for the next sweep. **A deferred row is not a
  failure.** The sweep continues; it will be retried on the next invocation once
  the meter is quiescent.
- `failed` — unexpected error; retried on the next sweep wrap.

**CAS miss behavior:** when a live `reserveStorageBytes` call bumps the revision
between revision capture and the CAS attempt, `reconcileStorageBytes` returns
`applied: false`. The reconcile function immediately defers — it does not retry.
The reservation byte count is fully preserved.

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
`calculateUserD1StorageBytes` is the physical payload recompute used by the
reconcile lane, cold-drift correction, and the parity report.

## Schema history

The pre-squash plan-column evolution (NULL rows → `'unlimited'` backfill → NOT
NULL → `'unlimited'` renamed to `'max'` → DEFAULT `'free'` → CHECK constraints)
is collapsed into the squashed baseline; the individual migration files live in
Git history only. `0002-restructure-plan-tiers.sql` renames stored `pro` to
`standard` and `partner` to `pro` (on `users.plan`, `users.stripe_plan`, and
`invites.plan`) and rebuilds both CHECK constraints for `free`, `standard`,
`pro`, and `max`.

## Assigning plans

New accounts start with `users.plan = 'free'` unless the consumed invite carries
another plan via `invites.plan` (NOT NULL DEFAULT `'free'`; writers and admin UI
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
- **MCP** — the `adminUserUpdate` capability (`requiredRole: 'admin'`) updates
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

Package-owned scheduled jobs also refresh their persisted caller identity and
published commit on every package sync, including when schedule, timezone, and
enabled state are unchanged. Execution rehydrates the account user from the job
row's stable user ID before exposing storage or nested MCP capabilities. The
stable-ID plan lookup remains a defense-in-depth fallback for legacy rows whose
saved caller context predates that refresh behavior.

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
- MCP `search` / `execute` tool errors that are entitlement or plan-limit
  denials also attach a focused `structuredContent.entitlement` object built
  from those same `details` (plus compact `used` / `remaining` on daily quota
  resources). Ordinary successful tool returns omit `entitlement`. The object
  never includes secrets, raw billing records, prices, or unrelated
  entitlements. See `packages/worker/src/mcp/entitlement-metadata.ts`.

## Counting strategy

- **Row-count limits** (saved packages, scheduled jobs, repo sessions, secrets)
  are counted via helpers in `service.ts`. APP_DB resources (saved packages,
  secrets) use built-in D1 counters. **Scheduled jobs** count through
  `jobsData(…).countJobsForUser` on the jobs worker (pass `getCurrent` into
  `assertWithinEntitlement`; there is no APP_DB built-in counter). **Repo
  sessions** count `status = 'active'` rows in the per-user `RepoSessionIndex`
  catalog. Unused (never-checkpointed) leftovers are swept after 30 minutes
  idle; checkpointed sessions after 7 days idle (`repo_session_cleanup` lane,
  100 rows per 5-minute tick). **Concurrent workflows** are authoritative in
  per-user RunLog `workflow_projections`: create reserves atomically via
  `reserveWorkflowProjectionSlot`, and usage readers call
  `countActiveWorkflowProjections` through
  `readCurrentEntitlementResourceUsage`. D1 has no `workflow_runs` table. See
  [Run records](./run-records.md).
- **Rate-style limits** (email sends/receives per day, execute calls per day,
  outbound fetches per day, job runs per day) are **authoritative in the
  per-user UserMeter Durable Object** (UTC day keys). Call
  `consumeDailyEntitlement` on every attempt: it resolves the plan limit,
  atomically checks and increments inside the DO, and throws
  `EntitlementLimitError` when over limit. Every resolved plan has a finite
  numeric limit. Counting attempts rather than successes keeps the limit
  abuse-resistant for permanent rejects (parse failures, entitlement/quota
  rejects).

  **Cold bootstrap:** missing `(resource, day)` rows trigger
  `UserMeter.initialize({ count: 0 })` (`INSERT OR IGNORE`) before retrying the
  consume. Concurrent cold callers cannot double-apply a non-zero baseline.

  **Daily counter authority:** consume/refund/inbound charge/read paths use
  `UserMeter`; D1 has no daily entitlement counter table.

  A delivery claim remains charged when later storage fails. Cloudflare Email
  Routing retries replay that same `delivery_id` through
  `UserMeter.consumeInboundDelivery` without incrementing again, including
  across a UTC-day boundary. The retained claim is the idempotency boundary;
  production inbound handling does not call `refundDailyEntitlement`.

- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- **Storage-byte limits** (`storage_bytes`) split into two quota components:
  1. **D1 payload bytes (authoritative in UserMeter):** user-owned D1 rows with
     durable payloads (`email_messages.raw_size` plus extracted message
     bodies/metadata, externally stored attachments, values, encrypted secrets,
     memories, saved-package projections, jobs, repo/session metadata, package
     invocation results, and published artifact metadata). Run records in the
     per-user `RunLog` Durable Object are intentionally **excluded** — they are
     observability history, not user content. Write chokepoints atomically
     reserve positive byte deltas via `assertWithinStorageBytesEntitlement`
     against the UserMeter DO (every caller, including email). Cold DO
     singletons zero-initialize (INSERT OR IGNORE, concurrent-safe) before
     retrying the reserve. The bounded `d1_storage_reconciliation` lane
     recomputes the physical cross-surface sum via `calculateUserD1StorageBytes`
     and applies it to UserMeter via a revision-guarded CAS (never clobbers a
     live reservation); no byte values are written back to D1 — see
     [UserMeter](#usermeter).

  2. **Durable Object bucket estimates (separate):** StorageRunner buckets and
     RepoSession workspaces expose `estimatedBytes`. RepoSession sums SQLite
     `databaseSize` with `REPO_SESSION_BLOBS` prefix bytes. Inventory rows
     distinguish them by `kind` and persist the latest measurement on
     `user_storage_buckets.estimated_bytes`. Repo sessions register on open,
     refresh after workspace mutations, and remove their rows on
     discard/purge/session or source cleanup. Write chokepoints that pass
     `getCurrent` compose
     `UserMeter payload bytes (readStorageBytesFromUserMeter) + sum of per-bucket estimates`
     for a **check-only** entitlement comparison — `getCurrent` never reserves.
     Only the bucket that triggers the baseline read (plus any inventoried
     bucket with no stored estimate yet) is probed live; every other bucket
     contributes its stored D1 estimate, so mutating writes do not fan
     `getEstimatedBytes` RPCs across the whole inventory. Live probe results are
     persisted fire-and-forget with **UPDATE-only** statements (they can never
     recreate an inventory row removed by account, package, or job deletion),
     and mutating StorageRunner and RepoSession RPCs opportunistically refresh
     their own bucket's stored estimate after the write, throttled per bucket
     per isolate (`storageBucketEstimateRefreshMinIntervalMs`). Stored estimates
     are freshness hints with bounded lag — acceptable for an order-of-magnitude
     cap because the bucket paying the baseline read is measured live and the
     run cache accounts for the run's own accepted writes. `requested` is the
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
     per-bucket DO read _rejections_ in production) before failing closed for
     the caller. The underlying DO RPC is not cancelled if the runtime keeps it
     running, so a timeout does **not** open a second stub call to the same
     `storageId` — retries keep waiting on the in-flight promise. Fast rejects
     still start a new RPC after backoff. A scheduled job that still fails
     closed treats this as a transient occurrence error: the claimed run stays
     `running` so the scheduler can abandon it and retry the same `scheduledFor`
     instead of finishing a terminal error that idempotency would replay. A cron
     lane (`storage_bucket_estimate_backfill`,
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

**Account usage reporting:** `usageGet` and the account usage UI report the same
two storage components: authoritative D1 payload bytes from UserMeter plus the
latest non-null estimates in `user_storage_buckets`. A newly inventoried bucket
with no estimate contributes zero until the estimate-backfill lane or a
write-target probe records its first measurement. Enforcement remains more
conservative: it live-probes the bucket being written and every unmeasured
bucket, then adds those results to the D1 payload counter. Reporting can
therefore lag enforcement briefly. Account usage reporting includes
StorageRunner bucket estimates with the D1 payload counter. The two values are
not alternate D1 counters and do not change storage-limit semantics.

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

The exemplar is package job sync: `syncPackageJobsForPackage` in
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
import { jobsData } from '#worker/jobs/jobs-data.ts'

await assertWithinEntitlement({
	db: env.APP_DB,
	userId,
	email: userEmail,
	resource: 'scheduled_jobs',
	getCurrent: () =>
		jobsData(env).countJobsForUser({
			userId,
		}),
})
```

Pass `getCurrent` for any resource that is not APP_DB-countable
(`scheduled_jobs` via `jobsData`, `repo_sessions` via `RepoSessionIndex`,
workflows via RunLog, and similar).

4. If the resource is a new one, register it in `plans.ts`
   (`entitlementResources`, `PlanLimits`, `planLimits`,
   `entitlementResourceLabels`, `resolvePlanLimit`) and add a built-in counter
   in `service.ts` when it is D1-countable.
5. Test both sides: a plan user at the limit is denied with
   `details.code === 'entitlement_limit_exceeded'` (assert `resource`, `plan`,
   `limit`, `current`). Build the test user's id with
   `createStableUserIdFromEmail(email)` (or any stored `stable_user_id`) and
   assert plan lookup against the email + stable-id pair; a mismatched pair must
   resolve as `free`.

## Enforcement points

| Resource                   | Enforcement point                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_jobs`           | Full-addition preflight in `syncPackageJobsForPackage` in `packages/worker/src/jobs/service.ts` (package sync subtracts same-sync removals before checking, so replacements do not consume an extra slot). Free also asserts `minJobIntervalMs` (15 minutes) on create or schedule change; existing faster jobs are grandfathered. |
| `saved_packages`           | new-package branch of `packageSave` and projection insert                                                                                                                                                                                                                                                                          |
| `repo_sessions`            | `repoOpenSession` before creating a new session                                                                                                                                                                                                                                                                                    |
| `email_sends_per_day`      | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`)                                                                                                                                                                                                                                                |
| `email_receives_per_day`   | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)                                                                                                                                                                                                                  |
| `stored_email_messages`    | `handleInboundEmail` before storage (`assertWithinEntitlement`; `max` caps from `planLimits.max`)                                                                                                                                                                                                                                  |
| `email_message_bytes`      | `handleInboundEmail` after inbound reduction (`assertWithinEntitlement` on kept raw size via `resolvePlanLimit`). Wire size above 25 MiB (`maxSurvivableInboundRawBytes`) rejects at SMTP. Mail between the persist cap and 25 MiB is reduced (text kept, oversized parts omitted) and stored.                                     |
| `secrets`                  | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                                                                                                                                                                                                                   |
| `concurrent_workflows`     | `createDynamicCallableWorkflow` (`reserveWorkflowProjectionSlot` + `assertWithinEntitlement` getCurrent; `max` = 5,000)                                                                                                                                                                                                            |
| `execute_calls_per_day`    | MCP `execute` tool handler (`consumeDailyEntitlement` before bundling/sandbox)                                                                                                                                                                                                                                                     |
| `outbound_fetches_per_day` | `executeGatewayFetch` (`consumeDailyEntitlement` before secret expansion)                                                                                                                                                                                                                                                          |
| `job_runs_per_day`         | `executeJobOnce` (`consumeDailyEntitlement` before sandbox work; cron, interval, and run-now)                                                                                                                                                                                                                                      |
| `storage_bytes`            | UserMeter DO reserve via `assertWithinStorageBytesEntitlement` (atomic `reserveStorageBytes`; cold zero-init bootstrap; required `env.USER_METER`); StorageRunner write tools/app RPCs (`getCurrent` check-only for bucket component)                                                                                              |

## Billing

Optional Stripe subscription billing lives in `packages/worker/src/billing/`
(raw `fetch` client — no Stripe SDK; `STRIPE_API_BASE_URL` overrides the API
host for tests/mocks). Without `STRIPE_SECRET_KEY`, billing surfaces degrade to
manual plans only. `STRIPE_STANDARD_PRICE_ID` /
`STRIPE_STANDARD_YEARLY_PRICE_ID` and `STRIPE_PRO_PRICE_ID` /
`STRIPE_PRO_YEARLY_PRICE_ID` independently enable checkout for their
corresponding tier and interval; an unset price id only disables purchase of
that interval. Yearly price ids and historical monthly price ids resolve to
`standard` / `pro` entitlements.

Checkout sessions are created server-side for authenticated users via
`POST /account/billing/checkout.json` (Stripe Checkout Session, JSON body
`{ plan: "standard" | "pro", interval?: "month" | "year" }` defaulting to
`month`, `mode=subscription`, with a signed `client_reference_id` and
`metadata.kody_stable_user_id`). Sessions enable Stripe automatic tax
(`automatic_tax[enabled]`; Stripe Tax is active on the account and computes 0
until a registration exists), tax-ID collection for business customers, and
promotion codes; when an existing `customer` is passed, `customer_update`
address/name are `auto` so Checkout can store what tax needs. There is no public
Payment Link path — checkout requires a signed-in session so unauthenticated
card-testing is not possible. `GET /account/billing/success` verifies
`client_reference_id` before linking `users.stripe_customer_id`, then refreshes
`users.stripe_plan` and renders a thank-you page (Discord invite;
connect-your-agent when `needsOnboarding`). A successful `stripe_plan` write
also best-effort re-syncs official Kody Discord Standard/Pro roles when the user
has a Discord social-login connection (see
[`social-login.md`](../social-login.md)). `GET /account/billing/portal` opens
the Stripe customer portal for linked customers.

### Account deletion refunds

Account deletion is the one automatic refund path (the Terms of Service say so).
Before the destructive steps, `deleteUserAccount` refunds the unused remainder
of the current period for each `active` or `trialing` subscription and then
cancels it immediately; dunning, paused, and incomplete subscriptions are
canceled without a refund. The client helpers are
`listPaidInvoicesForSubscription`
(`GET /v1/invoices?subscription=… &status=paid&limit=10`, walked newest first to
the invoice that still covers the period), `listCreditNotesForInvoice` (retry
idempotency, keyed on the `kody_account_deletion=1` metadata marker),
`listCreditNotesForCustomer` (so the deletion report includes notes from earlier
attempts), and `createProratedRefundCreditNote`, which previews then creates one
credit note with a `lines[n][type]=invoice_line_item` / `lines[n][amount]` entry
per eligible invoice line and `refund_amount` equal to the previewed total. Line
amounts are gross (pre-discount, tax-exclusive) like the invoice line's own
`amount`; Stripe prorates each line's discounts and tax into the credit note and
refunds that total to the original payment method. The prorated amount per line
is `floor(lineAmount * (period.end - now) / (period.end - period.start))`. The
refund is hard-capped at
`maxRefundMinor = invoice.amount_paid − Σ total of every issued credit note on the invoice (any issuer)`:
a mid-cycle upgrade invoice (portal upgrades bill with `always_invoice`) has a
positive new-plan line plus a negative unused-time credit for the old plan, so
`amount_paid` is the net and the positive line's unused fraction alone can
exceed it. Both credit note listings follow `has_more` / `starting_after` to the
end (up to `creditNoteListMaxPages` = 20 pages of 100); a listing still
reporting more after that throws `StripeCreditNoteListIncompleteError`, which
the refund path treats as an unknown remainder and therefore a cap of zero. A
cap of zero or less means nothing to refund; while the preview exceeds the cap
every line is scaled by `cap / previewedTotal` (floored, integer arithmetic —
the gross lines and the net, tax-inclusive preview only ever meet as a ratio)
and previewed again, up to `creditNoteCapFitAttempts` = 6 times. If it still
does not fit, `createProratedRefundCreditNote` returns `unfittable` and the
deletion logs `account_deletion_refund_unfittable`, audits
`account_deletion_refund_skipped`, and cancels without refunding that invoice (a
missing refund on a rounding edge is a support ticket; a blocked deletion is a
broken promise). Any other refund failure is a billing failure
(`AccountDeletionBillingError`): the account is retained for retry, exactly like
a failed cancel; only a preview that totals zero or a charge Stripe reports as
already fully refunded is treated as "nothing to refund". A rejected create is
logged as `account_deletion_refund_rejected` with the subscription and invoice
ids, the amount paid, the cap, and the requested amount (no PII). The full
sequence, skip conditions, audit action, and result shape are documented with
the rest of the deletion flow in
[`data-storage.md`](./data-storage.md#account-deletion-inventory).

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

Idempotency uses the `stripe_webhook_events` table from
`packages/worker/migrations/0001-squashed-init.sql`
(`stripe_webhook_events.event_id` unique). Events are processed first (handlers
are idempotent), then recorded. A UNIQUE conflict after a successful process is
treated as duplicate success (`200`). Process failures return `500` without
inserting so Stripe can retry. Rows older than 30 days are pruned by retention.

### Activity-driven backup

Billing refresh is activity-driven; there is no global hourly customer scan.
Checkout completion and subscription/invoice webhooks refresh immediately and
also arm the owning user's one-shot `StripePlanRefresh` Durable Object alarm for
one hour later. That independent retry closes over transient Stripe failures
without repeatedly enumerating inactive users. `/account/billing` arms the same
backstop and still refreshes on every view so non-persisted `cancel_at` /
`subscriptionStatus` stay current. If checkout cannot arm its backstop, a failed
immediate refresh remains an error so the caller or Stripe webhook retries
instead of acknowledging an unrecoverable stale projection. The
`stripe_customer_id` (unique partial index), `stripe_plan`, and
`stripe_plan_refreshed_at` columns ship in the squashed baseline; the alarm DO
class exists without moving canonical billing data out of D1.

Published prices: Free $0, Standard $12/mo or $120/year ($10/mo billed
annually), Pro $49/mo or $480/year ($40/mo billed annually). Env vars and deploy
wiring are documented in
[`../environment-variables.md`](../environment-variables.md).

## Related tables and coordination

- `users.plan` — NOT NULL DEFAULT `'free'` (squashed baseline plus the 0002 tier
  rename). The entitlements module is the consumer of that column (manual /
  invite / admin grant).
- `invites.plan` — signup plan; NOT NULL DEFAULT `'free'` (writers and admin UI
  default to `free`). Applied to `users.plan` when the invite is consumed at
  signup via `parseStoredPlanName` and `resolvePlanWrite`.
- `users.stripe_customer_id`, `users.stripe_plan`,
  `users.stripe_plan_refreshed_at` — Stripe billing columns owned by
  `packages/worker/src/billing/`, read by `getUserPlan` via
  `resolveEffectivePlan`. `stripe_plan` stays nullable because it is
  Stripe-derived; `max` is manual-only.
