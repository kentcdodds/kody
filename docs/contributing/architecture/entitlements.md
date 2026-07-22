# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` remain independently configured placeholders.

Module: `packages/worker/src/entitlements/`

- `plans.ts` — plan names (`free`, `pro`, `partner`, `max`, `unlimited`), the
  `PlanLimits` config per plan, `max` email caps (`maxPlanEmailLimits`), the
  `EntitlementResource` registry, `resolvePlanLimit(plan, resource)`,
  `resolveEmailResourceLimit(plan, resource)`, `getPlanRank`, `parsePlanName`
  (strict, untrusted direct user-plan input), `parseInviteAssignablePlanName`
  (strict invite creation), `parseStoredPlanName` and
  `parseStoredInvitePlanName` (stored-column reads), and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
- `service.ts` — `getUserPlan`, `assertWithinEntitlement`, built-in D1 usage
  counters, and the daily-counter helpers for rate-style limits.

## Plan model

The plan registry in `plans.ts` includes `free`, `pro`, `partner`, `max`, and
`unlimited`. Finite plans (`free`, `pro`, `partner`, `max`) have numeric limits
for every resource. Emergency `unlimited` bypasses entitlement ceilings (null
limits); it is not a public, paid, or Stripe-sourced tier.

`users.plan` and `invites.plan` are NOT NULL TEXT columns. Historical migrations
(`0046-invites-email-verification.sql`, `0065-invite-plans.sql`, and
`0081-plan-not-null.sql`) left the DDL default as `'unlimited'` through
`0082-rename-unlimited-plan-to-max.sql`, which renames stored `'unlimited'` rows
to `'max'` but does not change the column default. Migration
`0083-plan-default-free.sql` reconciles migration-window residual `'unlimited'`
to `'max'`, fails closed if any remain, and rebuilds both columns as NOT NULL
DEFAULT `'free'`. Migration `0084-purge-residual-unlimited-plan.sql` sweeps any
residual stored `'unlimited'` on `users.plan` and `invites.plan` to `'max'` and
fails closed if any remain — a gap closer before code enables the new explicit
admin-only `unlimited` tier. **Live DDL defaults and writers always persist a
known plan name (never NULL); normal creation and reset paths default to
`free`.**

**Write and default:** `resolvePlanWrite` maps nullish admin/API inputs to
`free` for admin-created accounts, platform-account provisioning, seed SQL, and
admin plan resets on direct user-plan paths. Explicit `max` and emergency
`unlimited` remain valid deliberate assignments on those paths only
(`/admin/users` and MCP `admin_user_update`). Invite creation and signup
consumption use `resolveInvitePlanWrite`, which maps nullish inputs to `free`
and never persists `unlimited` — only finite invite-assignable plans (`free`,
`pro`, `partner`, `max`).

**Reading stored values:**

- **`users.plan`** — `parseStoredPlanName`. Known names, including deliberate
  `unlimited`, pass through unchanged. Defensive NULL and unknown stored strings
  fail open to `max` with a stable `entitlement-unknown-stored-plan` warn tag
  (no user data in the log).
- **`invites.plan`** — `parseStoredInvitePlanName`. Invite-assignable names pass
  through; residual stored `'unlimited'` fails open to `max` with
  `entitlement-residual-unlimited-invite-plan`; other unknown / nullish values
  fail open to `max` with `entitlement-unknown-stored-plan`. Residual invite
  `unlimited` never creates an unlimited account at signup.
- **Untrusted input** — direct user-plan assignment validates with strict
  `parsePlanName` (accepts `unlimited` for deliberate admin assignment). Invite
  creation validates with `parseInviteAssignablePlanName`, which rejects
  `unlimited`.

`users.stripe_plan` stays nullable because it is Stripe-derived; `max` and
`unlimited` are manual-only — admin-visible, not paid or public — and never
written from Stripe (`parseStripePlanName` rejects both).

`resolveEffectivePlan(manual, stripe)` compares a non-null manual plan (after
`parseStoredPlanName`) with `users.stripe_plan`. Manual `max` and `unlimited`
always win over Stripe; otherwise the higher-ranked of the two is returned.
Unknown or null `stripe_plan` values contribute nothing.

### Emergency `unlimited` plan

`unlimited` is a true uncapped emergency override: every resource limit resolves
to null so `assertWithinEntitlement` and daily-counter gates bypass enforcement.
Daily counters may still accumulate uncapped for later assignment visibility.

Assignment is **direct to an existing user only**, through two audited
admin-only surfaces (both backed by `updateAdminUserPlan`):

- **Admin UI** — the "Manage plan" panel on `/admin/users`
- **MCP** — `admin_user_update` (`requiredRole: 'admin'`)

Both write an `admin`-category audit event with reason
`target_user_id=…;plan=…`.

`unlimited` is never available on invite creation, signup defaults,
admin-created accounts, platform-account provisioning, seed SQL, Stripe
checkout, or any public paid tier. Former top-tier `'unlimited'` stored values
were renamed to `'max'` by migrations `0082`–`0084`; only deliberate post-0084
admin assignment creates new `unlimited` rows.

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
NOT NULL DEFAULT `'free'`. Migration `0084-purge-residual-unlimited-plan.sql`
reconciles any later residual `'unlimited'` on `users.plan` and `invites.plan`
to `'max'` before code enables the new explicit admin-only `unlimited` tier; it
does not touch `users.stripe_plan`, unknown plan strings, or DDL defaults.

## Assigning plans

New accounts start with `users.plan = 'free'` unless the consumed invite carries
another plan. Migration `0065-invite-plans.sql` adds `invites.plan` (NOT NULL
DEFAULT `'free'` after `0083-plan-default-free.sql`; writers and admin UI
default to `free`). Password and social signup read the consumed invite's stored
plan with `parseStoredInvitePlanName` and copy it onto `users.plan` via
`resolveInvitePlanWrite` (finite invite-assignable plans only); missing or
omitted invite plans are written as `free`. Residual stored invite `'unlimited'`
coerces to `max` at read time with `entitlement-residual-unlimited-invite-plan`.
Admin-created accounts, platform-account provisioning, and seed SQL always start
on `free` and never accept `unlimited`. Admins set invite plans when creating
codes at `/admin/invites` (validated with strict
`parseInviteAssignablePlanName`, which rejects `unlimited`; emergency
`unlimited` cannot be persisted through invites).

Admins assign or reset plans on **existing** users through two audited,
admin-only surfaces, both backed by `updateAdminUserPlan` in
`packages/worker/src/app/admin-users-data.ts`:

- **Admin UI** — the "Manage plan" panel on `/admin/users` posts
  `{ action: 'update_plan', userId, plan }` to `POST /admin/users.json` (guarded
  by `update:user:any`). `plan: null` maps to `free` (writers never persist
  NULL); unknown plan strings are rejected with `400` rather than coerced.
  Emergency `unlimited` is selectable here only.
- **MCP** — the `admin_user_update` capability (`requiredRole: 'admin'`) updates
  one user by `id` or `email` and accepts `plan: PlanName | null` (null maps to
  `free`; explicit `unlimited` is preserved for deliberate direct assignment).

Both paths validate against the full plan registry (`parsePlanName` /
`planNames`) and write an `admin`-category audit event with reason
`target_user_id=…;plan=…`.

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

1. Normalizes the email and returns `max` when email or `userId` is absent (no
   warn).
2. Returns `max` without touching D1 when `userId` is not a 64-char hex string.
   Synthetic runtime contexts (package-scoped caller contexts with `email: ''`,
   workflow-internal users, test fixtures) therefore resolve to `max`.
3. Reads
   `SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`
   and returns `resolveEffectivePlan(parseStoredPlanName(plan), stripe_plan)`. A
   mismatched email/stable-id pair or missing row returns `max` (no warn).

Consequence: enforcement points must have the acting user's account email
available. Both auth surfaces provide it — app sessions expose
`user.mcpUser.email` and MCP caller contexts expose
`ctx.callerContext.user.email`. Code paths that genuinely have no user email
(for example package-manifest job sync or workflow-spawned inline code) resolve
to `max` at plan lookup — acceptable because they are only reachable after a
user action that is itself gated.

One path still needs explicit account resolution: inbound email routing has no
caller context but must enforce receive quotas. It resolves the owning account
via the indexed username lookup (`findPublicUserIdentityByUsername`) — it does
not reverse-resolve stable user ids. `findUserAccountByStableUserId` in
`service.ts` remains the reverse-resolution helper for other contextless paths
(package-runtime contexts that act with only the stable userId, mirroring
`findUserAccount` in `email/platform-address.ts`): `users.stable_user_id` is NOT
NULL with a unique index (migrations 0052 + 0075; written at signup from
`createStableUserIdFromEmail`, preserved across email changes), so reverse
lookup is always one indexed point read. Only use it on contextless paths;
interactive surfaces already carry the email.

## The error shape

Every enforcement point throws `EntitlementLimitError` from
`entitlements/errors.ts` and lets it propagate unchanged. Its `details` field is
the stable programmatic contract:

```ts
{
	code: 'entitlement_limit_exceeded',
	resource: EntitlementResource, // e.g. 'scheduled_jobs'
  plan: PlanName,                // always a known plan name (including `max` / `unlimited`)
	limit: number,
	current: number,
	upgradeHint: string,
}
```

The `message` is built by `buildEntitlementLimitMessage` and is the single
user-facing string across MCP and UI surfaces:

> Plan limit reached: your "pro" plan allows at most 50 scheduled jobs and you
> currently have 50. Remove or finish existing scheduled jobs you no longer
> need, or ask the operator of this Kody deployment to upgrade your plan.

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
  concurrent workflows, running package services) are counted **directly from
  their source D1 tables at the enforcement point** via built-in counters in
  `service.ts`. They do not depend on any metering or rollup tables.
- **Rate-style limits** (email sends and receives per day) use the
  `entitlement_daily_counters` table keyed by `(user_id, resource, day)` with
  UTC day keys. Call `consumeDailyEntitlement` on every attempt: it checks the
  plan limit from `resolvePlanLimit` and increments the counter in one
  conditional D1 upsert (no check-then-increment race). Finite plans have a
  numeric limit; emergency `unlimited` bypasses the gate (null limit) but
  counters may still increment uncapped. Counting attempts rather than successes
  keeps the limit abuse-resistant for permanent rejects (parse failures,
  entitlement/quota rejects). Only typed pre-commit
  `RetryableInboundStorageError` failures (thread prework, R2 put, D1
  message/attachment storage after successful cleanup) refund exactly one
  `email_receives_per_day` unit via `refundDailyEntitlement` for the same UTC
  day that was charged, so Cloudflare Email Routing retries do not burn the
  daily receive quota. Post-commit bookkeeping failures do not refund or retry.
  `incrementDailyEntitlementCounter` remains for raw counter writes (tests,
  backfills).
- **Boolean allowances** (persistent package services) are modeled as limit `0`
  (not allowed) vs `1` (allowed) so the numeric contract stays uniform.
- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- **Storage-byte limits** (`storage_bytes`) use a built-in D1 byte estimate for
  user-owned rows with durable payloads (`email_messages.raw_size` plus
  extracted message bodies/metadata, externally stored attachments, values,
  encrypted secrets, memories, saved-package projections, jobs, repo/session
  metadata, package invocation results, package runtime debug rows, and
  published artifact metadata). StorageRunner Durable Object buckets expose
  their own `estimatedBytes`; write chokepoints that target a specific bucket
  pass `getCurrent` as `D1 estimate + target bucket estimate` and `requested` as
  the candidate payload size when known. The counter intentionally does **not**
  attempt to scan Cloudflare Artifacts repository contents, KV snapshot/bundle
  bodies, R2 object listings beyond `email_messages.raw_size`, or Vectorize:
  those stores either lack reliable byte metadata or are derived from D1 and are
  documented in `data-storage.md`.

### Concurrency

Row-count limits are check-then-insert: the count query and the later insert are
separate statements, so a burst of concurrent creates can overshoot a limit by a
few rows before the next check sees the new count. That is an accepted trade-off
— these limits are order-of-magnitude denial-of-wallet caps, not billing-grade
accounting, and folding every insert into a conditional statement would couple
the entitlements module to each resource's write path. The rate-style path does
not share this window: `consumeDailyEntitlement` checks and increments in a
single conditional upsert.

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

| Resource                      | Enforcement point                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                                                                     |
| `saved_packages`              | new-package branch of `package_save` and projection insert                                                                          |
| `package_services`            | `service_start` capability path                                                                                                     |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                                                                          |
| `repo_sessions`               | `repo_open_session` before creating a new session                                                                                   |
| `email_sends_per_day`         | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`)                                                 |
| `email_receives_per_day`      | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)                   |
| `stored_email_messages`       | `handleInboundEmail` before storage (`assertWithinEntitlement`; `max` caps from `planLimits.max`)                                   |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size via `resolveEmailResourceLimit`; see inbound raw-MIME backstop below) |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                    |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (plan limit from `resolvePlanLimit`; `max` = 5,000)                                                 |
| `storage_bytes`               | D1 payload writes (values, secrets, memories, saved-package projections, email storage) and StorageRunner write tools/app RPCs      |

### Inbound raw-MIME platform backstop

Emergency `unlimited` resolves `email_message_bytes` to null, so entitlement
enforcement does not cap per-message size. Inbound routing still applies a hard
platform ceiling: `handleInboundEmail` sets the MIME parser's `maxRawSize` to
the plan cap when finite, otherwise to `maxRawMimeBytes` (512 KiB in
`packages/worker/src/email/parser.ts`). That backstop keeps extracted bodies
plus raw blobs within D1 row-size limits and prevents parser work on arbitrarily
large payloads. Entitlement bypass and parser backstop are intentional: uncapped
usage quotas do not imply uncapped parse/storage safety.

## Billing

Optional Stripe subscription billing lives in `packages/worker/src/billing/`
(raw `fetch` client — no Stripe SDK; `STRIPE_API_BASE_URL` overrides the API
host for tests/mocks). Without `STRIPE_SECRET_KEY`, billing surfaces degrade to
manual plans only.

Checkout sessions are created server-side for authenticated users via
`POST /account/billing/checkout.json` (Stripe Checkout Session,
`mode=subscription`, with a signed `client_reference_id`). Public Payment Links
were removed after a card-testing incident so checkout is not reachable without
a signed-in session. `GET /account/billing/success` verifies
`client_reference_id` before linking `users.stripe_customer_id`, then refreshes
`users.stripe_plan`. `GET /account/billing/portal` opens the Stripe customer
portal for linked customers.

`users.stripe_plan` stays fresh via an hourly cron lane
(`refreshStaleStripePlans`: 25 users/sweep, 1h staleness) and an on-page refresh
when `/account/billing` loads with data older than 60s. Migration
`0066-stripe-billing.sql` adds `stripe_customer_id` (unique partial index),
`stripe_plan`, and `stripe_plan_refreshed_at`.

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
  signup via `parseStoredInvitePlanName` and `resolveInvitePlanWrite` (finite
  invite-assignable plans only). Residual stored invite `'unlimited'` coerces to
  `max` with `entitlement-residual-unlimited-invite-plan`; emergency `unlimited`
  cannot be persisted through invites.
- `users.stripe_customer_id`, `users.stripe_plan`,
  `users.stripe_plan_refreshed_at` — Stripe billing columns from migration
  `0066-stripe-billing.sql`; owned by `packages/worker/src/billing/`, read by
  `getUserPlan` via `resolveEffectivePlan`. `stripe_plan` stays nullable because
  it is Stripe-derived; `max` and `unlimited` are manual-only.
- `entitlement_daily_counters` — rate counters, created by migration
  `0048-user-plans-and-entitlement-counters.sql`; included in the
  account-deletion cascade (`packages/worker/src/app/account-deletion.ts`).
