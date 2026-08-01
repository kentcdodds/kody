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
  `assertWithinEntitlement`, built-in D1 usage counters, and the daily-counter
  helpers for rate-style limits.

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

**D1 payload storage bytes** (`storage_bytes`) stay authoritative on D1
`users.d1_storage_bytes` (migration 0122). UserMeter schema v4 adds an optional
`storage_bytes_state` singleton as a **best-effort shadow** for future cutover —
it does not drive reads, reserves, or reconciliation in this additive slice.

**D1 package service liveness** (`package_service_states`) stays authoritative
for running counts, discovery, and `service_start` enforcement. UserMeter schema
v5 adds an optional per-service shadow table as **best-effort future-cutover
support only** — see
[Package service liveness — UserMeter shadow](#package-service-liveness--usermeter-shadow-expand-phase-slice-4-phase-a).

**Account-deletion write fencing** uses a split authority model after slice 5
Phase B: D1 `users.deleting_at` remains the permanent point gate; callers that
supply `USER_METER` treat UserMeter (`authority='do'`) as authoritative for
lease acquire/held/release/drain count, while email/transition callers that omit
`env` keep the exact D1 `account_write_leases` path. See
[Account-deletion write fencing — UserMeter authority](#account-deletion-write-fencing--usermeter-authority-expand-phase-slice-5-phase-b).

StorageRunner bucket `estimatedBytes` and the per-bucket inventory in
`user_storage_buckets` stay a **separate** quota component. StorageRunner write
chokepoints pass `getCurrent` as a check-only composed total (D1 payload bytes
from `readUserD1StorageBytes` plus bucket estimates); that path does **not**
reserve bytes in D1 or UserMeter.

**Strong enforcement:** `consumeDailyEntitlement` and inbound
`consumeInboundDelivery` RPCs check the plan limit and increment inside the DO.
The Durable Object request model serializes mutations per user; counter updates
use optimistic concurrency on monotonic `revision` so concurrent consumes cannot
overshoot. Missing `(resource, day)` rows return `needs_bootstrap` rather than
silently starting at zero on a warm account.

**Cold bootstrap:** on `needs_bootstrap`, the service performs one legacy D1
point read on `entitlement_daily_counters`, then `UserMeter.initialize()` seeds
the row with `INSERT OR IGNORE` (concurrent callers cannot double-apply the
baseline). The warm enforcement path awaits only the DO RPC — never APP_DB.

**Non-awaited D1 mirror:** after each successful consume, refund, or inbound
delivery claim, the service schedules a best-effort absolute mirror write to
`entitlement_daily_counters` via `waitUntil` when available (otherwise a caught
void promise). Mirror ordering uses the DO-minted `mirrorUpdatedAt` token
(`r/` + zero-padded revision) in the existing `updated_at` TEXT column so late
writes cannot overwrite newer state, including refunds that lower `count`.
Mirror failures are logged and never affect enforcement. The D1 table is **not**
dropped in this phase — it remains for existing readers and reporting.

**Point-read surfaces** call `readDailyEntitlementResourceUsage` (UserMeter with
the same cold-bootstrap path):

- Account usage UI — `packages/worker/src/app/account-usage-data.ts`
- Account email usage panel — `packages/worker/src/app/account-email-data.ts`
- `email_usage_get` MCP capability
- Admin per-user usage drill-down —
  `packages/worker/src/admin/user-usage-data.ts`

Non-daily resources and contexts without `USER_METER` still use
`readEntitlementResourceUsage` against D1.

During a rolling deployment, requests already running on the previous Worker
version may still increment D1 after a new-version request bootstraps its DO
row. Cloudflare activation bounds that overlap to in-flight requests, but
operators should treat mirror parity during the deploy window as approximate;
post-deploy requests have one authority in UserMeter.

**Inbound retry idempotency:** inbound receive quota uses
`UserMeter.consumeInboundDelivery`, which atomically claims `delivery_id` and
consumes one `email_receives_per_day` unit inside a SQLite transaction. Retries
return the accepted counter without incrementing (`replayed: true`).
Cross-UTC-day retries use the original claim's resource/day. The legacy D1
mirror is scheduled from the email path via
`scheduleAbsoluteDailyEntitlementMirror` so the email subsystem does not
duplicate mirror SQL.

### D1 payload storage bytes — UserMeter shadow (expand phase slice 3)

D1 `users.d1_storage_bytes` and `users.d1_storage_bytes_updated_at` remain the
**sole read, enforcement, and reconciliation authority** for the D1 payload
component of `storage_bytes`. Every caller — including email — reserves through
the same conditional D1 `UPDATE` in `assertWithinStorageBytesEntitlement`
(bounded retry while a real users row remains under limit; fail closed if
contention never resolves; missing-user synthetic contexts keep prior
under-limit allow / over-limit deny). Denial semantics and
`EntitlementLimitError` always come from D1.

UserMeter schema **v4** adds a singleton `storage_bytes_state` row (`id = 1`) as
**best-effort shadow / future-cutover support only**. The DO row is never read
for usage display or enforcement in this slice.

**Optional non-email shadow writes:** DO-backed write chokepoints (values,
secrets, memories, and saved-package projections) may pass optional `env` into
`assertWithinStorageBytesEntitlement`. After a **successful D1 reserve**, the
service schedules a non-awaited best-effort shadow via `waitUntil` when
available: re-read the latest D1 value, then absolute-set UserMeter through
`setStorageBytes`. Shadow tasks re-read D1 at execution time so a delayed shadow
cannot apply a stale absolute and leave the DO behind D1. Missing `USER_METER`
or shadow failures log `entitlement-storage-bytes-shadow-failed` and never
affect D1 enforcement.

**Optional reconcile shadow:** `reconcileUserD1StorageBytes` absolute-sets D1
from `calculateUserD1StorageBytes` and awaits that write. When optional `env` is
present, it best-effort shadows the post-update D1 value into UserMeter; shadow
failures are logged and never fail or poison the lane. The
`d1_storage_reconciliation` scheduled-lane wiring passes `env`, so every
successful absolute reconciliation also advances the expand-phase shadow.

**Usage reads stay on D1:** account usage, admin drill-down, and
`readCurrentEntitlementResourceUsage` for `storage_bytes` call
`readUserD1StorageBytes` only.

**Account export and purge:** `UserMeter.exportCounters` may return additive
non-authoritative shadow fields on the first page only (`startAfter` absent):
`storageBytesShadow` when the schema-v4 row exists, and
`packageServiceStatesShadow` when schema-v5 service rows exist. Subsequent pages
return `null` for each shadow so paged consumers never double-count them
(section totals still count each shadow inventory once when present).
`UserMeter.purge()` clears counters, inbound delivery claims, and all shadow
state (storage bytes and package-service liveness) via `deleteAll`.

### Package service liveness — UserMeter shadow (expand phase slice 4, Phase A)

D1 `package_service_states` remains the **sole authority** for running-service
**count**, **discovery**, and **`service_start` enforcement** in this PR.
Nothing in Phase A switches those reads or the `assertWithinEntitlement` path
for `package_services` / `persistent_package_services`.

UserMeter schema **v5** adds a per-service `package_service_states` table inside
the DO as **best-effort shadow / future-cutover support only** (`status`,
`started_at`, monotonic `source_updated_at` from the D1 projection timestamp,
`revision`, `updated_at`). User scope is the DO identity — there is no `user_id`
column. Shadow rows are never read for usage display, entitlement enforcement,
or account-deletion inventory in this slice.

**Dual-write from `PackageServiceInstance`:** every D1 projection also attempts
a best-effort UserMeter shadow on the same lifecycle surface:

- lifecycle transitions and warm-start restore after upgrades
  (`projectServiceStateToD1`)
- running-service heartbeat alarms (1h `packageServiceStateHeartbeatMs`,
  unchanged)
- stop, error, and idle projections that clear `running`
- purge (`deleteProjectedServiceState` deletes D1 then shadow before
  `deleteAll`)

D1 upsert/delete runs first; shadow RPCs are optional when `USER_METER` is
unbound and failures log `package-service-user-meter-shadow-failed` without
affecting the service path. Shadow upserts reject stale/out-of-order writes when
`sourceUpdatedAt` is older than the existing shadow row so cold bootstrap cannot
clobber fresher state.

**Timing unchanged:** live services heartbeat D1 `updated_at` every **1 hour**
(`packageServiceStateHeartbeatMs`). Running counts still treat rows as stale
after **24 hours** without a fresh heartbeat (`packageServiceStateStaleMs` in
`entitlements/service.ts`). The UserMeter cutover-support RPC
`countRunningPackageServices` uses the same 24h window on shadow
`source_updated_at` but is **not** wired to enforcement in Phase A.

**Account export:** `UserMeter.exportCounters` returns additive
`packageServiceStatesShadow` on the first page only (`startAfter` absent); later
pages return `null`. Section totals count the shadow inventory once when
present; the field is explicitly non-authoritative — authoritative liveness
remains on D1.

**Account purge:** `UserMeter.purge()` clears package-service shadow rows with
the rest of DO state via `deleteAll`.

### Account-deletion write fencing — UserMeter authority (expand phase slice 5, Phase B)

UserMeter schema **v7** stores `account_write_leases.authority` (`do` |
`legacy`; rows created under v6 default to `legacy`) and `pending_repair_id` for
audit-safe DO repair.

**Split authority:**

- D1 `users.deleting_at` remains the **permanent point gate** (auth projection /
  purge failures fail closed). Assert-only readers (`assertAccountWritable*`)
  stay D1-only. D1 `account_write_leases` / `account_write_lease_repairs` tables
  are **not** retired.
- When `env.USER_METER` is supplied (all non-email Phase-A-wired callers),
  UserMeter is **authoritative** for lease acquire / held / release via
  `acquireWriteLease` / `assertWriteLeaseHeld` / `releaseWriteLease`
  (`authority='do'`). Missing binding or DO failures **fail closed**.
- When `env` is omitted (email transition), retain the **exact D1 lease path**
  (including `active_write_count`, ALS nested reuse, and `waitUntil` release).

**Temporary rolling-version D1 mirror (not the final hot path):** while older
isolates may still run Phase-A mark (D1-only lease counts), every DO-authority
acquire also inserts the **same** `token` / `holder` / `acquiredAt` into D1
`account_write_leases` and bumps `active_write_count` with the existing atomic
batch + lost-response reconcile. If that D1 mirror cannot be confirmed, the DO
lease is released and acquire fails closed. Authoritative release clears the DO
lease first, then the D1 mirror/`active_write_count` (same `waitUntil`
detachment semantics) so a stale D1 row may overblock old marks but never
underblock. After old isolates drain, remove this mirror (and later the D1 lease
inventory) from the hot path.

**`markAccountDeleting`:** always `COALESCE`s D1 `deleting_at` first, then loads
live D1 leases (including temporary DO mirrors). With `env`, calls authoritative
`markDeleting` which sets/preserves the DO tombstone, replaces **only legacy**
rows with that exact D1 snapshot, preserves DO-authority rows, and returns the
deduped-by-token union count used for drain waits. Without `env`, returns the D1
lease count unchanged (so Phase-A marks observe DO acquires via the mirror).

**Admin list / repair:** `listActiveAccountWriteLeases(db, userId, env?)` with
`env` unions live D1 leases + DO-authority leases (dedupe by token, same
`acquired_at, token` order); without `env` exact D1 behavior. DO repair is
audit-first and idempotent: prepare (stable `repairId`, lease stays held) →
insert/verify D1 audit → finalize exact pending DO repair → then idempotently
clear matching D1 mirror/count. The D1 mirror is never cleared while the DO
lease remains held. Finalize failure without commit leaves DO + D1 mirror held
and fails closed; retry resumes the pending repair. Retry after finalize commit
/ lost response returns success when the matching audit exists and the DO lease
is absent (clears any stale D1 mirror; never falls through to a mismatched D1
atomic batch). Post-write held checks treat pending repair as held until
finalize, then surface `AccountWriteLeaseLostError`. Pure D1 leases keep the
existing atomic audit-before-release batch.

**Account export / purge:** first-page sanitized `deletionShadow` still omits
raw token/holder. `purge()` clears leases/counters/shadows via `deleteAll` then
restores any deleting tombstone; D1 `deleting_at` remains the gate.

Public errors, ALS nested-lease reuse, holder strings, and `waitUntil` release
detachment stay parity-compatible with the pre-cutover surface.

### Future package-service authority flip (contract follow-up)

A separate **high-risk contract PR** — not a merge blocker for Phase A — will
flip running-service count/discovery/enforcement into UserMeter only after:

1. at least one full **24h stale-window soak** with shadow/D1 parity review, and
2. a **cold-bootstrap design** for accounts whose DO shadow is empty while D1
   still holds rows (`bootstrapPackageServiceStates` / equivalent).

Until that flip, shadow divergence is acceptable; D1 remains the contract. **D1
likely stays the enumeration index** for account export, deletion, and admin
discovery until an alternate inventory exists — UserMeter would become the
running-count authority first, not a wholesale replacement for every D1 reader.

### Future storage authority flip (contract follow-up)

A separate contract PR will flip D1 payload storage-byte authority into
UserMeter once **mailbox-do** passes `env` on email inbound/outbound storage
reservations. Cron reconciliation shadowing is already wired.

Only then do reads, reserves, and reconciliation switch to UserMeter-first with
D1 as mirror/cursor. Until that flip, shadow divergence is acceptable; D1
remains the contract.

**Current UserMeter cutover:** slice 5 Phase B moves non-email write leases into
UserMeter authority while retaining the D1 `deleting_at` gate and temporary
same-token rollout mirrors; email keeps its D1 lease path. Package-service and
storage authority flips remain separate high-risk contract follow-ups after
soak/parity review.

**Daily-counter mirror retirement:** dropping D1 `entitlement_daily_counters`
waits until reporting-off-D1 work merges and mirror parity is verified in
production.

### Admin UserMeter parity gates (`admin_user_meter_parity`)

Production verification for mirror retirement and authority flips uses the
admin-only read-only capability `admin_user_meter_parity` (input:
`stable_user_id`). It compares production-shaped D1 rows for one account against
direct UserMeter RPCs and never bootstraps or writes parity state. Opening a
cold UserMeter stub may still run Durable Object constructor schema maintenance
and opportunistic stale daily-counter pruning. Cold meter rows surface as
`needsBootstrap` with `meterCount`/`meterBytes` null.

Interpret the structured report as independent gates:

| Gate                             | Pass condition                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily counters (current UTC day) | Each of the four daily resources has `parity: true` (`d1Count === meterCount`); aggregate `daily.mismatchCount === 0`.                                                                                                                                                              |
| Storage bytes                    | `storage.parity` — D1 `users.d1_storage_bytes` equals UserMeter `readStorageBytes` (not `needsBootstrap`).                                                                                                                                                                          |
| Package services                 | `packageServices.parity` — inventory mismatch category counts are all zero (`d1Only` / `meterOnly` / `statusMismatch` / `startedAtMismatch` / `sourceUpdatedAtMismatch`), fresh-running counts match under the shared 24h stale window, and the meter page walk is not `truncated`. |
| Deletion tombstone               | `deletion.deletingAtParity` — D1 `users.deleting_at` matches the meter tombstone.                                                                                                                                                                                                   |
| Temporary D1 lease mirror        | `deletion.mirrorLeaseParity` — `doOnly === 0`, `legacyWithoutD1 === 0`, inventory not truncated, and `d1ActiveLeaseCount >= doAuthorityLeaseCount` (same-token mirror coverage). `tokenSetMismatches.d1Only` is reported but does **not** fail this gate.                           |

**D1-only leases:** email and other transition paths that omit `env` still take
exact D1 leases, so `d1Only > 0` is expected until that handoff. Mirror-removal
readiness therefore ignores `d1Only`. Operators separately confirm those rows
are known email/transition holders via `admin_account_write_lease_list` and
holder classification before retiring the temporary D1 mirror inventory.

**Threshold:** treat unexplained mismatches as blocking for the corresponding
cutover (daily mirror retirement, storage authority flip, package-service
authority flip, or temporary D1 lease-mirror removal). Expected cold accounts
may report `needsBootstrap` until live traffic or an intentional bootstrap path
seeds the DO; that is a bootstrap gap, not a silent pass. Truncated inventories
fail closed (`parity` / `mirrorLeaseParity` false) so operators re-run or raise
the bounded page cap rather than approve a partial compare.

Module wiring: `consumeDailyEntitlement`, `refundDailyEntitlement`, and
`readDailyEntitlementResourceUsage` require `env.USER_METER` and fail closed
when the binding is missing. Storage-byte helpers (`readUserD1StorageBytes`,
`assertWithinStorageBytesEntitlement`, `reconcileUserD1StorageBytes`) treat
`USER_METER` as optional shadow-only; missing binding is a no-op for shadow
scheduling.

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
  running package services) are counted **directly from their source D1 tables
  at the enforcement point** via built-in counters in `service.ts`. They do not
  depend on any metering or rollup tables. Running package services are counted
  from D1 `package_service_states` (status `running` and freshly heartbeaten; 1h
  heartbeat, 24h staleness), not from run-history rows — see
  [Run records](./run-records.md) (`state-vs-history`). Expand-phase slice 4
  Phase A dual-writes the same projection into UserMeter as a non-authoritative
  shadow; enforcement and `service_start` still read D1 only. **Concurrent
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

  **Cold bootstrap:** missing `(resource, day)` rows trigger one legacy D1 point
  read and a single `UserMeter.initialize()` before retrying the consume.

  **D1 mirror (expand phase):** after each successful consume/refund/inbound
  claim, a best-effort, non-awaited absolute mirror write updates
  `entitlement_daily_counters` with revision-ordered `updated_at` tokens. The
  table is not dropped — it remains for existing readers and reporting until
  reporting-off-D1 retirement is verified.

  A delivery claim remains charged when later storage fails. Cloudflare Email
  Routing retries replay that same `delivery_id` through
  `UserMeter.consumeInboundDelivery` without incrementing again, including
  across a UTC-day boundary. The retained claim is the idempotency boundary;
  production inbound handling does not call `refundDailyEntitlement`.

  `incrementDailyEntitlementCounter` remains for raw D1 counter writes (tests,
  backfills, and legacy paths).

- **Boolean allowances** (persistent package services) are modeled as limit `0`
  (not allowed) vs `1` (allowed) so the numeric contract stays uniform.
- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- **Storage-byte limits** (`storage_bytes`) split into two quota components:
  1. **D1 payload bytes (authoritative on D1):** user-owned D1 rows with durable
     payloads (`email_messages.raw_size` plus extracted message bodies/metadata,
     externally stored attachments, values, encrypted secrets, memories,
     saved-package projections, jobs, repo/session metadata, package invocation
     results, and published artifact metadata). Run records in the per-user
     `RunLog` Durable Object are intentionally **excluded** — they are
     observability history, not user content. Write chokepoints atomically
     reserve positive byte deltas via `assertWithinStorageBytesEntitlement`
     against `users.d1_storage_bytes` (every caller, including email). Optional
     `env` on non-email paths schedules a best-effort UserMeter shadow after a
     successful D1 reserve; shadow state is not read for enforcement or usage.
     The bounded `d1_storage_reconciliation` lane recomputes the authoritative
     cross-surface sum via `calculateUserD1StorageBytes` and absolute-sets D1;
     optional `env` shadows into UserMeter after the D1 write — see
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

| Resource                      | Enforcement point                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                                                                                                                                                          |
| `saved_packages`              | new-package branch of `package_save` and projection insert                                                                                                                                                               |
| `package_services`            | `service_start` capability path (count from `package_service_states`)                                                                                                                                                    |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                                                                                                                                                               |
| `repo_sessions`               | `repo_open_session` before creating a new session                                                                                                                                                                        |
| `email_sends_per_day`         | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`)                                                                                                                                      |
| `email_receives_per_day`      | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)                                                                                                        |
| `stored_email_messages`       | `handleInboundEmail` before storage (`assertWithinEntitlement`; `max` caps from `planLimits.max`)                                                                                                                        |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size via `resolveEmailResourceLimit`)                                                                                                                           |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                                                                                                         |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (`reserveWorkflowProjectionSlot` + `assertWithinEntitlement` getCurrent; `max` = 5,000)                                                                                                  |
| `storage_bytes`               | D1 payload writes via `assertWithinStorageBytesEntitlement` (D1 reserve for all callers; optional `env` shadow on non-email paths) and StorageRunner write tools/app RPCs (`getCurrent` check-only for bucket component) |

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
- `entitlement_daily_counters` — expand-phase **mirror** of UserMeter daily
  counters (authoritative state in the per-user `UserMeter` DO), created by
  migration `0048-user-plans-and-entitlement-counters.sql`; included in the
  account-deletion cascade (`packages/worker/src/app/account-deletion.ts`).
  Table retirement waits until reporting-off-D1 merges and mirror parity is
  verified.
