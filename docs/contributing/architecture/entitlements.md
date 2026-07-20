# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` remain independently configured placeholders.

Module: `packages/worker/src/entitlements/`

- `plans.ts` — plan names (`free`, `pro`, `partner`), the `PlanLimits` config
  per plan, the `EntitlementResource` registry,
  `resolvePlanLimit(plan, resource)`, `getPlanRank`, and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
- `service.ts` — `getUserPlan`, `assertWithinEntitlement`, built-in D1 usage
  counters, and the daily-counter helpers for rate-style limits.

## The NULL-plan invariant

`users.plan` is a nullable TEXT column (added by migration
`0046-invites-email-verification.sql`). **NULL means legacy/unlimited**: nothing
is enforced, and no counting query runs, for users without a plan. Unknown
stored plan values are also treated as NULL so plan renames can never lock users
out. Enforcement activates only when a known plan name is set — existing
accounts keep working unchanged.

A Stripe subscription never downgrades a NULL manual plan into enforcement:
`resolveEffectivePlan` returns NULL whenever `users.plan` is NULL, regardless of
`users.stripe_plan`. Legacy/unlimited accounts stay unlimited until an admin or
invite assigns a manual plan.

Exception: the email resources are abuse-sensitive and bind plan-less users to
the `nullPlanEmailFallbackLimits` backstops from `plans.ts` instead of unlimited
— outbound sends (`email_sends_per_day`) because sending is an outreach-abuse
surface, and the inbound resources (`email_receives_per_day`,
`stored_email_messages`, `email_message_bytes`) because inbound volume is
attacker-controlled (anyone can send to a `{username}@<platform domain>`
address). Use `resolveEmailResourceLimit` to read the effective limit for those
resources.

## Assigning plans

New accounts start with `users.plan = NULL` (legacy/unlimited plus the email
backstops above) unless the consumed invite carries a plan. Migration
`0065-invite-plans.sql` adds nullable `invites.plan`. Password and social signup
apply that value to the new `users.plan` when present (validated with
`parsePlanName`); a NULL invite plan keeps today's legacy/unlimited behavior.
Admins set invite plans when creating codes at `/admin/invites`.

Admins also assign or clear plans on existing users through two audited,
admin-only surfaces, both backed by `updateAdminUserPlan` in
`packages/worker/src/app/admin-users-data.ts`:

- **Admin UI** — the "Manage plan" panel on `/admin/users` posts
  `{ action: 'update_plan', userId, plan }` to `POST /admin/users.json` (guarded
  by `update:user:any`). `plan: null` clears the plan; unknown plan strings are
  rejected with `400` rather than coerced to null.
- **MCP** — the `admin_user_update` capability (`requiredRole: 'admin'`) updates
  one user by `id` or `email` and accepts `plan: PlanName | null`.

Both paths validate against the plan registry (`parsePlanName` / `planNames`)
and write an `admin`-category audit event with reason `target_user_id=…;plan=…`.
Because daily counters accumulate even for plan-less users, assigning a plan
later binds immediately against the usage already counted that day.

Paid upgrades via Stripe write `users.stripe_plan` (not `users.plan`); see
[Billing](#billing). Effective entitlement uses the higher-ranked of the two
when a manual plan is set.

## Plan lookup

The MCP `userId` is the SHA-256 hash of the normalized account email
(`createStableUserIdFromEmail`), so `users.plan` cannot be joined on that id
directly. `getUserPlan(db, { userId, email })`:

1. Normalizes the email and returns null (unlimited) when it is absent.
2. Verifies `sha256(email) === userId` and returns null on mismatch, without
   touching D1. This keeps the per-user-isolation invariant honest and makes
   synthetic runtime contexts (package-scoped caller contexts with `email: ''`,
   workflow-internal users, test fixtures) fail open.
3. Reads `SELECT plan, stripe_plan FROM users WHERE email = ?` and returns
   `resolveEffectivePlan(parsePlanName(plan), stripe_plan)`: NULL manual plan
   stays unlimited; otherwise the higher-ranked of manual `users.plan` and
   `users.stripe_plan` (rank: `free` < `pro` < `partner`).

Consequence: enforcement points must have the acting user's account email
available. Both auth surfaces provide it — app sessions expose
`user.mcpUser.email` and MCP caller contexts expose
`ctx.callerContext.user.email`. Code paths that genuinely have no user email
(for example package-manifest job sync or workflow-spawned inline code) are
documented fail-open gaps, acceptable because they are only reachable after a
user action that is itself gated.

One path cannot fail open: inbound email routing has no caller context but must
enforce receive quotas. It resolves the owning account via the indexed username
lookup (`findPublicUserIdentityByUsername`) — it does not reverse-resolve stable
user ids. `findUserAccountByStableUserId` in `service.ts` remains the
reverse-resolution helper for other contextless paths (package-runtime contexts
that act with only the hashed userId, mirroring `findUserAccount` in
`email/platform-address.ts`): stored `stable_user_id` values are one indexed
point read (unique partial index from migration 0052, persisted at signup),
positive matches are cached per isolate (the mapping is a content hash, so hits
can never go stale) and re-verified with one point read. Only use it on
contextless paths; interactive surfaces already carry the email.

Legacy rows with a NULL `stable_user_id` still fall back to a scan that hashes
each email, but the scan is self-healing: a match writes the computed id back
(`UPDATE ... WHERE stable_user_id IS NULL`), so each legacy row pays the scan at
most once. The authenticated `POST /__maintenance/backfill-stable-user-ids`
endpoint (`backfillStableUserIds` in
`packages/worker/src/maintenance-handler.ts`) backfills all remaining legacy
rows in keyset-paged batches, eliminating the scan entirely for existing
deployments.

## The error shape

Every enforcement point throws `EntitlementLimitError` from
`entitlements/errors.ts` and lets it propagate unchanged. Its `details` field is
the stable programmatic contract:

```ts
{
	code: 'entitlement_limit_exceeded',
	resource: EntitlementResource, // e.g. 'scheduled_jobs'
	plan: PlanName | null,         // null when a global fallback limit applied
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
  plan limit and increments the counter in one conditional D1 upsert (no
  check-then-increment race), and still increments (uncapped) for users without
  a plan so counters reflect real usage the moment a plan is assigned — unless
  the caller passes `fallbackLimit`, which caps plan-less users with a
  deployment-level backstop (both email sends and receives do this). Counting
  attempts rather than successes keeps the limit abuse-resistant.
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

Because the plan check happens before any counting, enforcement adds zero
counting overhead for NULL-plan users.

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

   Use `fallbackLimit` only for global backstops that must bind plan-less users
   (the workflow concurrency limit absorbed the `WORKFLOW_CONCURRENT_LIMIT` env
   var this way via `getWorkflowConcurrencyBackstop`, and the email resources
   cap plan-less users via `nullPlanEmailFallbackLimits`).
   `consumeDailyEntitlement` accepts the same `fallbackLimit` for daily rate
   resources. Use `getCurrent` only when the built-in D1 counter cannot express
   the resource.

4. If the resource is a new one, register it in `plans.ts`
   (`entitlementResources`, `PlanLimits`, `planLimits`,
   `entitlementResourceLabels`, `resolvePlanLimit`) and add a built-in counter
   in `service.ts` when it is D1-countable.
5. Test both sides: a plan user at the limit is denied with
   `details.code === 'entitlement_limit_exceeded'` (assert `resource`, `plan`,
   `limit`, `current`), and a NULL-plan user is unaffected. Build the test
   user's id with `createStableUserIdFromEmail(email)` so the plan lookup's hash
   verification passes.

## Enforcement points

| Resource                      | Enforcement point                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                                                                |
| `saved_packages`              | new-package branch of `package_save` and projection insert                                                                     |
| `package_services`            | `service_start` capability path                                                                                                |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                                                                     |
| `repo_sessions`               | `repo_open_session` before creating a new session                                                                              |
| `email_sends_per_day`         | `sendOutboundEmail` (atomic `consumeDailyEntitlement`, NULL-plan backstop)                                                     |
| `email_receives_per_day`      | `handleInboundEmail` (atomic `consumeDailyEntitlement`, NULL-plan fallback)                                                    |
| `stored_email_messages`       | `handleInboundEmail` before storage (NULL-plan fallback)                                                                       |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size, NULL-plan fallback)                                             |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                               |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (plan limit, env-var backstop for NULL plan)                                                   |
| `storage_bytes`               | D1 payload writes (values, secrets, memories, saved-package projections, email storage) and StorageRunner write tools/app RPCs |

## Billing

Optional Stripe subscription billing lives in `packages/worker/src/billing/`
(raw `fetch` client — no Stripe SDK; `STRIPE_API_BASE_URL` overrides the API
host for tests/mocks). Without `STRIPE_SECRET_KEY`, billing surfaces degrade to
manual plans only.

Checkout uses Stripe Payment Links with `client_reference_id` set to the user's
stable id and `prefilled_email` set to their account email.
`GET /account/billing/success` verifies `client_reference_id` before linking
`users.stripe_customer_id`, then refreshes `users.stripe_plan`.
`GET /account/billing/portal` opens the Stripe customer portal for linked
customers.

`users.stripe_plan` stays fresh via an hourly cron lane
(`refreshStaleStripePlans`: 25 users/sweep, 1h staleness) and an on-page refresh
when `/account/billing` loads with data older than 60s. Migration
`0066-stripe-billing.sql` adds `stripe_customer_id` (unique partial index),
`stripe_plan`, and `stripe_plan_refreshed_at`.

Published prices: Free $0, Pro $5/mo. Env vars and deploy wiring are documented
in [`../environment-variables.md`](../environment-variables.md).

## Related tables and coordination

- `users.plan` — added by the invite-signup migration
  (`0046-invites-email-verification.sql`); the entitlements module is the
  consumer of that column (manual / invite / admin grant).
- `invites.plan` — nullable signup plan from migration `0065-invite-plans.sql`;
  applied to `users.plan` when the invite is consumed at signup.
- `users.stripe_customer_id`, `users.stripe_plan`,
  `users.stripe_plan_refreshed_at` — Stripe billing columns from migration
  `0066-stripe-billing.sql`; owned by `packages/worker/src/billing/`, read by
  `getUserPlan` via `resolveEffectivePlan`.
- `entitlement_daily_counters` — rate counters, created by migration
  `0048-user-plans-and-entitlement-counters.sql`; included in the
  account-deletion cascade (`packages/worker/src/app/account-deletion.ts`).
