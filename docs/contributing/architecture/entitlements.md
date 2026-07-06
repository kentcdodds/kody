# Entitlements (plans and quotas)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. It deliberately contains **no payment code** — billing
integration comes later, after usage metering informs the limit numbers.

Module: `packages/worker/src/entitlements/`

- `plans.ts` — plan names (`partner`, `personal`, `pro`), the `PlanLimits`
  config per plan, the `EntitlementResource` registry, and
  `resolvePlanLimit(plan, resource)`.
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

Exception: the inbound email resources (`email_receives_per_day`,
`stored_email_messages`, `email_message_bytes`) apply the
`nullPlanEmailFallbackLimits` backstops from `plans.ts` to plan-less users,
because inbound volume is attacker-controlled (anyone who learns an alias can
send to it). Use `resolveEmailResourceLimit` to read the effective limit for
those resources.

## Plan lookup

The MCP `userId` is the SHA-256 hash of the normalized account email
(`createStableUserIdFromEmail`), so `users.plan` cannot be joined on that id
directly. `getUserPlan(db, { userId, email })`:

1. Normalizes the email and returns null (unlimited) when it is absent.
2. Verifies `sha256(email) === userId` and returns null on mismatch, without
   touching D1. This keeps the per-user-isolation invariant honest and makes
   synthetic runtime contexts (package-scoped caller contexts with `email: ''`,
   workflow-internal users, test fixtures) fail open.
3. Reads `SELECT plan FROM users WHERE email = ?` and validates the value
   against the plan registry.

Consequence: enforcement points must have the acting user's account email
available. Both auth surfaces provide it — app sessions expose
`user.mcpUser.email` and MCP caller contexts expose
`ctx.callerContext.user.email`. Code paths that genuinely have no user email
(for example package-manifest job sync or workflow-spawned inline code) are
documented fail-open gaps, acceptable because they are only reachable after a
user action that is itself gated.

One path cannot fail open: inbound email routing has no caller context but must
enforce receive quotas. `findUserAccountByStableUserId` in `service.ts`
reverse-resolves the stable user id to the account email (and plan) by scanning
the users table and hashing each email — the same pattern
`isAccountEmailVerified` uses. Positive matches are cached per isolate (the
mapping is a content hash, so hits can never go stale) and re-verified with one
point read. Only use it on contextless paths; interactive surfaces already carry
the email.

The cold-path scan is O(users) per isolate on an attacker-reachable path, which
is acceptable for the current single-digit user count only. **A persisted
`users.stable_user_id` column (indexed, with an app-level backfill — SQLite
cannot compute SHA-256 in a migration) is required before onboarding external
users / design partners**; the scan must not ship into multi-tenant use.

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

> Plan limit reached: your "personal" plan allows at most 10 scheduled jobs and
> you currently have 10. Remove or finish existing scheduled jobs you no longer
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
  deployment-level backstop (inbound email does this). Counting attempts rather
  than successes keeps the limit abuse-resistant.
  `incrementDailyEntitlementCounter` remains for raw counter writes (tests,
  backfills).
- **Boolean allowances** (persistent package services) are modeled as limit `0`
  (not allowed) vs `null` (allowed) so the numeric contract stays uniform.
- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- `maxStorageBytes` is defined in the limits config but **still not enforced**;
  it has no built-in counter and requires `getCurrent` when it gains an
  enforcement point. The per-message `email_message_bytes` cap bounds each
  stored email's size but is deliberately **not** full storage-bytes accounting
  — that remains a separate effort.

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
   receives `userId` today; MCP capabilities get it from
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

   Use `fallbackLimit` only to preserve a pre-existing global backstop for
   plan-less users (the workflow concurrency limit absorbed the
   `WORKFLOW_CONCURRENT_LIMIT` env var this way via
   `getWorkflowConcurrencyBackstop`). Use `getCurrent` only when the built-in D1
   counter cannot express the resource.

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

| Resource                      | Enforcement point                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `scheduled_jobs`              | `createJob` in `packages/worker/src/jobs/service.ts` (exemplar)                    |
| `saved_packages`              | new-package branch of `package_save` and projection insert                         |
| `package_services`            | `service_start` capability path                                                    |
| `persistent_package_services` | `service_start` for services declared `mode: 'persistent'`                         |
| `repo_sessions`               | `repo_open_session` before creating a new session                                  |
| `email_sends_per_day`         | `sendOutboundEmail` (atomic `consumeDailyEntitlement`)                             |
| `email_receives_per_day`      | `handleInboundEmail` (atomic `consumeDailyEntitlement`, NULL-plan fallback)        |
| `stored_email_messages`       | `handleInboundEmail` before storage (NULL-plan fallback)                           |
| `email_message_bytes`         | `handleInboundEmail` before quota/parse (per-message raw size, NULL-plan fallback) |
| `secrets`                     | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`   |
| `concurrent_workflows`        | `createDynamicCallableWorkflow` (plan limit, env-var backstop for NULL plan)       |
| `storage_bytes`               | not yet enforced                                                                   |

## Related tables and coordination

- `users.plan` — added by the invite-signup migration
  (`0046-invites-email-verification.sql`); the entitlements module is the
  consumer of that column.
- `entitlement_daily_counters` — rate counters, created by migration
  `0048-user-plans-and-entitlement-counters.sql`; included in the
  account-deletion cascade (`packages/worker/src/app/account-deletion.ts`).
