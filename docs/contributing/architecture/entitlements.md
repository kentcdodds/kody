# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` remain independently configured placeholders.

Module: `packages/worker/src/entitlements/`

- `plans.ts` — plan names (`free`, `pro`, `partner`, `unlimited`), the
  `PlanLimits` config per plan, deployment email backstops
  (`unlimitedPlanEmailLimits`), the `EntitlementResource` registry,
  `resolvePlanLimit(plan, resource)`,
  `resolveEmailResourceLimit(plan, resource)`, `getPlanRank`, `parsePlanName`
  (strict, untrusted input), `parseStoredPlanName` (stored-column reads), and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
- `service.ts` — `getUserPlan`, `assertWithinEntitlement`, built-in D1 usage
  counters, and the daily-counter helpers for rate-style limits.

## Plan model

`users.plan` and `invites.plan` are NOT NULL TEXT columns with default
`'unlimited'` (migrations `0046-invites-email-verification.sql`,
`0065-invite-plans.sql`, and `0081-plan-not-null.sql`). The plan registry in
`plans.ts` includes `free`, `pro`, `partner`, and `unlimited`.

**Write and default:** writers always persist a plan name (never NULL).
`resolvePlanWrite` maps nullish admin/API inputs to `unlimited`, which is the
default for new accounts, invites without an explicit plan, and admin plan
resets.

**Reading stored values:** D1 reads use `parseStoredPlanName`. Known plan names
pass through unchanged; defensive NULL and unknown stored strings fail open to
`unlimited` with a stable `entitlement-unknown-stored-plan` warn tag (no user
data in the log). Untrusted admin/API input still uses strict `parsePlanName` so
typos and unknown strings are rejected rather than coerced.

The **`unlimited` plan** gives ordinary resources uncapped limits (`null` in
`planLimits`), uses deployment-level email backstops
(`unlimitedPlanEmailLimits`), and keeps the workflow concurrency env global
backstop (`maxConcurrentWorkflows: null` plus `fallbackLimit`).

`users.stripe_plan` stays nullable because it is Stripe-derived; `unlimited` is
manual-only and never written from Stripe (`parseStripePlanName` rejects it).

`resolveEffectivePlan(manual, stripe)` compares a non-null manual plan (after
`parseStoredPlanName`) with `users.stripe_plan`. Manual `unlimited` always wins
over Stripe; otherwise the higher-ranked of the two is returned. Unknown or null
`stripe_plan` values contribute nothing.

Exception: the email resources are abuse-sensitive and bind the `unlimited` plan
to the `unlimitedPlanEmailLimits` backstops from `plans.ts` instead of uncapped
inbound/outbound mail — outbound sends (`email_sends_per_day`) because sending
is an outreach-abuse surface, and the inbound resources
(`email_receives_per_day`, `stored_email_messages`, `email_message_bytes`)
because inbound volume is attacker-controlled (anyone can send to a
`{username}@<platform domain>` address). Use `resolveEmailResourceLimit` to read
the effective limit for those resources.

## Schema history

Migration `0080-backfill-unlimited-plan.sql` backfilled pre-existing NULL
`users.plan` / `invites.plan` rows to `'unlimited'`. Migration
`0081-plan-not-null.sql` reconciles any residual NULLs and rebuilds both columns
as NOT NULL DEFAULT `'unlimited'`.

## Assigning plans

New accounts start with `users.plan = 'unlimited'` (plus the email backstops
above) unless the consumed invite carries another plan. Migration
`0065-invite-plans.sql` adds `invites.plan` (NOT NULL DEFAULT `'unlimited'`
after `0081-plan-not-null.sql`). Password and social signup read the consumed
invite's stored plan with `parseStoredPlanName` and copy it onto `users.plan`;
missing or omitted invite plans use the column default `unlimited`. Admins set
invite plans when creating codes at `/admin/invites` (validated with strict
`parsePlanName`).

Admins also assign or reset plans on existing users through two audited,
admin-only surfaces, both backed by `updateAdminUserPlan` in
`packages/worker/src/app/admin-users-data.ts`:

- **Admin UI** — the "Manage plan" panel on `/admin/users` posts
  `{ action: 'update_plan', userId, plan }` to `POST /admin/users.json` (guarded
  by `update:user:any`). `plan: null` maps to `unlimited` (writers never persist
  NULL); unknown plan strings are rejected with `400` rather than coerced.
- **MCP** — the `admin_user_update` capability (`requiredRole: 'admin'`) updates
  one user by `id` or `email` and accepts `plan: PlanName | null` (null maps to
  `unlimited`).

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

1. Normalizes the email and returns `unlimited` when email or `userId` is
   absent.
2. Returns `unlimited` without touching D1 when `userId` is not a 64-char hex
   string. Synthetic runtime contexts (package-scoped caller contexts with
   `email: ''`, workflow-internal users, test fixtures) therefore resolve to
   `unlimited`.
3. Reads
   `SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`
   and returns `resolveEffectivePlan(parseStoredPlanName(plan), stripe_plan)`. A
   mismatched email/stable-id pair or missing row returns `unlimited`.

Consequence: enforcement points must have the acting user's account email
available. Both auth surfaces provide it — app sessions expose
`user.mcpUser.email` and MCP caller contexts expose
`ctx.callerContext.user.email`. Code paths that genuinely have no user email
(for example package-manifest job sync or workflow-spawned inline code) resolve
to `unlimited` at plan lookup — acceptable because they are only reachable after
a user action that is itself gated.

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
	plan: PlanName,                // always a known plan name (including `unlimited`)
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

- `details.plan` is always a known plan name (including `unlimited` when email
  caps from `unlimitedPlanEmailLimits` apply, or when a workflow concurrency
  `fallbackLimit` backstop applies); denial messages always quote that plan
  name.
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
  plan limit from `resolvePlanLimit` (including the `unlimited` plan's email
  caps in `planLimits.unlimited` via `unlimitedPlanEmailLimits`) and increments
  the counter in one conditional D1 upsert (no check-then-increment race). When
  the resolved plan limit is null, the counter still accumulates without a cap
  unless the caller passes `fallbackLimit` (production use: workflow concurrency
  only). Counting attempts rather than successes keeps the limit abuse-resistant
  for permanent rejects (parse failures, entitlement/quota rejects). Only typed
  pre-commit `RetryableInboundStorageError` failures (thread prework, R2 put, D1
  message/attachment storage after successful cleanup) refund exactly one
  `email_receives_per_day` unit via `refundDailyEntitlement` for the same UTC
  day that was charged, so Cloudflare Email Routing retries do not burn the
  daily receive quota. Post-commit bookkeeping failures do not refund or retry.
  `incrementDailyEntitlementCounter` remains for raw counter writes (tests,
  backfills).
- **Boolean allowances** (persistent package services) are modeled as limit `0`
  (not allowed) vs `null` (allowed) so the numeric contract stays uniform.
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

When the resolved plan limit is null (including the `unlimited` tier for
ordinary resources other than email), enforcement adds zero counting overhead
beyond any `fallbackLimit` backstop. Email resources always resolve a numeric
plan limit for every plan name, including `unlimited`.

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

Use `fallbackLimit` only for global backstops that must bind accounts whose plan
limit is null (today: workflow concurrency via `getWorkflowConcurrencyBackstop`,
which absorbs the `WORKFLOW_CONCURRENT_LIMIT` env var). Email abuse caps for the
`unlimited` plan live in `planLimits.unlimited` via `unlimitedPlanEmailLimits` —
register them in `planLimits` and read them through `resolvePlanLimit` /
`resolveEmailResourceLimit`; do not route email through `fallbackLimit`. Use
`getCurrent` only when the built-in D1 counter cannot express the resource.

4. If the resource is a new one, register it in `plans.ts`
   (`entitlementResources`, `PlanLimits`, `planLimits`,
   `entitlementResourceLabels`, `resolvePlanLimit`) and add a built-in counter
   in `service.ts` when it is D1-countable.
5. Test both sides: a plan user at the limit is denied with
   `details.code === 'entitlement_limit_exceeded'` (assert `resource`, `plan`,
   `limit`, `current`), and an `unlimited`-plan user (or a caller context that
   resolves to `unlimited`) is unaffected for ordinary capped resources. Build
   the test user's id with `createStableUserIdFromEmail(email)` (or any stored
   `stable_user_id`) and assert plan lookup against the email + stable-id pair;
   a mismatched pair must resolve as `unlimited`.

## Enforcement points

| Resource                      | Enforcement point                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                                                                 |
| `saved_packages`              | new-package branch of `package_save` and projection insert                                                                      |
| `package_services`            | `service_start` capability path                                                                                                 |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                                                                      |
| `repo_sessions`               | `repo_open_session` before creating a new session                                                                               |
| `email_sends_per_day`         | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`, `unlimited` via `unlimitedPlanEmailLimits`) |
| `email_receives_per_day`      | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)               |
| `stored_email_messages`       | `handleInboundEmail` before storage (`assertWithinEntitlement`; `unlimited` cap from `planLimits.unlimited`)                    |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size via `resolveEmailResourceLimit`)                                  |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (plan limit, env-var backstop for `unlimited`)                                                  |
| `storage_bytes`               | D1 payload writes (values, secrets, memories, saved-package projections, email storage) and StorageRunner write tools/app RPCs  |

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
  (`0046-invites-email-verification.sql`); NOT NULL DEFAULT `'unlimited'` after
  `0081-plan-not-null.sql`. The entitlements module is the consumer of that
  column (manual / invite / admin grant). Writers default to `unlimited`.
- `invites.plan` — signup plan from migration `0065-invite-plans.sql`; NOT NULL
  DEFAULT `'unlimited'` after `0081-plan-not-null.sql`. Applied to `users.plan`
  when the invite is consumed at signup via `parseStoredPlanName` (omitted plans
  use the column default `unlimited`).
- `users.stripe_customer_id`, `users.stripe_plan`,
  `users.stripe_plan_refreshed_at` — Stripe billing columns from migration
  `0066-stripe-billing.sql`; owned by `packages/worker/src/billing/`, read by
  `getUserPlan` via `resolveEffectivePlan`. `stripe_plan` stays nullable because
  it is Stripe-derived; `unlimited` is manual-only.
- `entitlement_daily_counters` — rate counters, created by migration
  `0048-user-plans-and-entitlement-counters.sql`; included in the
  account-deletion cascade (`packages/worker/src/app/account-deletion.ts`).
