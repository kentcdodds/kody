import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { EntitlementLimitError, buildEntitlementUpgradeHint } from './errors.ts'
import {
	parsePlanName,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'

/**
 * Resolve the plan for a user, or null when the user is legacy/unlimited.
 *
 * The MCP `userId` is the SHA-256 hash of the normalized account email, so
 * the lookup goes through the email while verifying that the email actually
 * hashes to the given userId. When the pair does not match (synthetic
 * runtime contexts, package-scoped caller contexts with an empty email, or
 * test fixtures), the lookup short-circuits to null without touching D1 —
 * which also means enforcement is skipped, matching the invariant that
 * enforcement only activates for users with a verified plan.
 */
export async function getUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName | null> {
	const email = input.email?.trim().toLowerCase()
	if (!email || !input.userId) return null
	if ((await createStableUserIdFromEmail(email)) !== input.userId) return null
	const row = await db
		.prepare(`SELECT plan FROM users WHERE email = ?`)
		.bind(email)
		.first<{ plan: string | null }>()
	return parsePlanName(row?.plan)
}

export function utcDayKey(date: Date = new Date()) {
	return date.toISOString().slice(0, 'YYYY-MM-DD'.length)
}

/**
 * Increment a daily counter for a rate-style entitlement (for example
 * email sends per day). Counters accumulate for every user regardless of
 * plan so that assigning a plan later enforces against real usage.
 */
export async function incrementDailyEntitlementCounter(input: {
	db: D1Database
	userId: string
	resource: EntitlementResource
	amount?: number
	now?: Date
}) {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(user_id, resource, day) DO UPDATE SET
				count = entitlement_daily_counters.count + excluded.count,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.resource,
			utcDayKey(now),
			input.amount ?? 1,
			now.toISOString(),
		)
		.run()
}

async function readDailyEntitlementCounter(input: {
	db: D1Database
	userId: string
	resource: EntitlementResource
	now: Date
}) {
	const row = await input.db
		.prepare(
			`SELECT count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = ? AND day = ?`,
		)
		.bind(input.userId, input.resource, utcDayKey(input.now))
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function countRows(db: D1Database, sql: string, params: Array<unknown>) {
	const row = await db
		.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Recency window for counting running package services. Service runs are
 * tracked in package_runtime_runs; rows can be left in 'running' after a
 * hard eviction, so stale rows older than this window are ignored to avoid
 * permanently locking a user out of their quota.
 */
const runningServiceCountWindowMs = 24 * 60 * 60 * 1000

async function countEntitlementUsage(input: {
	db: D1Database
	userId: string
	resource: EntitlementResource
	now: Date
}): Promise<number> {
	const { db, userId, resource, now } = input
	switch (resource) {
		case 'saved_packages':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM saved_packages WHERE user_id = ?`,
				[userId],
			)
		case 'scheduled_jobs':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM jobs WHERE user_id = ?`,
				[userId],
			)
		case 'package_services': {
			const windowStart = new Date(
				now.valueOf() - runningServiceCountWindowMs,
			).toISOString()
			return await countRows(
				db,
				`SELECT COUNT(DISTINCT package_id || '/' || COALESCE(name, '')) AS count
				FROM package_runtime_runs
				WHERE user_id = ?
					AND surface = 'service'
					AND status = 'running'
					AND started_at >= ?`,
				[userId, windowStart],
			)
		}
		case 'persistent_package_services':
			// Boolean allowance: the limit is 0 (not allowed) or null
			// (allowed), so the current count never changes the outcome.
			return 0
		case 'repo_sessions':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM repo_sessions
				WHERE user_id = ? AND status = 'active'`,
				[userId],
			)
		case 'email_sends_per_day':
			return await readDailyEntitlementCounter({
				db,
				userId,
				resource,
				now,
			})
		case 'secrets':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM secret_entries se
				JOIN secret_buckets sb ON sb.id = se.bucket_id
				WHERE sb.user_id = ?
					AND (sb.expires_at IS NULL OR sb.expires_at > ?)`,
				[userId, now.toISOString()],
			)
		case 'concurrent_workflows': {
			const placeholders = activeWorkflowStatusValues.map(() => '?').join(', ')
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM workflow_runs
				WHERE user_id = ? AND status IN (${placeholders})`,
				[userId, ...activeWorkflowStatusValues],
			)
		}
		case 'storage_bytes':
			throw new Error(
				'storage_bytes has no built-in counter; pass getCurrent to assertWithinEntitlement.',
			)
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}

export type AssertWithinEntitlementInput = {
	db: D1Database
	userId: string
	/**
	 * Account email of the acting user when available. Plan lookup requires
	 * it; when absent (synthetic runtime contexts) the user is treated as
	 * unlimited.
	 */
	email: string | null | undefined
	resource: EntitlementResource
	/** How many units the operation is about to consume. Defaults to 1. */
	requested?: number
	/** Override the built-in D1 usage counter for this resource. */
	getCurrent?: () => Promise<number>
	/**
	 * Limit that applies when the user has no plan. Used to absorb global
	 * backstops (for example the workflow concurrency env var) into the
	 * shared enforcement path. Default: no limit for plan-less users.
	 */
	fallbackLimit?: number | null
	now?: Date
}

/**
 * The single enforcement helper. Every entitlement enforcement point calls
 * this and lets the thrown EntitlementLimitError propagate unchanged so the
 * error shape and user-facing message stay identical across MCP and UI
 * surfaces.
 *
 * Users with a NULL (or unknown) plan are unlimited: the helper returns
 * before running any counting query, so enforcement adds no D1 reads for
 * legacy users beyond the single plan lookup (and not even that when the
 * caller context has no verified email).
 */
export async function assertWithinEntitlement(
	input: AssertWithinEntitlementInput,
): Promise<void> {
	const plan = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = plan
		? resolvePlanLimit(plan, input.resource)
		: (input.fallbackLimit ?? null)
	if (limit == null) return
	const now = input.now ?? new Date()
	const requested = input.requested ?? 1
	const current = input.getCurrent
		? await input.getCurrent()
		: await countEntitlementUsage({
				db: input.db,
				userId: input.userId,
				resource: input.resource,
				now,
			})
	if (current + requested > limit) {
		throw new EntitlementLimitError({
			resource: input.resource,
			plan,
			limit,
			current,
			upgradeHint: buildEntitlementUpgradeHint(input.resource),
		})
	}
}

/**
 * Atomically consume one unit of a daily rate-style entitlement (check and
 * increment in a single conditional D1 upsert), throwing
 * EntitlementLimitError when the consumption would exceed the plan limit.
 * This avoids the check-then-increment race that separate
 * assertWithinEntitlement + incrementDailyEntitlementCounter calls would
 * have under concurrent requests, and evaluates the UTC day key once.
 *
 * Users without a plan (or without a resolvable limit) consume without a
 * cap: the counter still accumulates so limits bind the moment a plan is
 * assigned.
 */
export async function consumeDailyEntitlement(input: {
	db: D1Database
	userId: string
	email: string | null | undefined
	resource: EntitlementResource
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	const plan = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = plan ? resolvePlanLimit(plan, input.resource) : null
	if (limit == null) {
		await incrementDailyEntitlementCounter({
			db: input.db,
			userId: input.userId,
			resource: input.resource,
			now,
		})
		return
	}
	const throwLimitError = async () => {
		throw new EntitlementLimitError({
			resource: input.resource,
			plan,
			limit,
			current: await readDailyEntitlementCounter({
				db: input.db,
				userId: input.userId,
				resource: input.resource,
				now,
			}),
			upgradeHint: buildEntitlementUpgradeHint(input.resource),
		})
	}
	// The fresh-row INSERT branch is unconditional, so a limit below one
	// unit can never be satisfied and must be rejected up front.
	if (limit < 1) {
		await throwLimitError()
	}
	const result = await input.db
		.prepare(
			`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(user_id, resource, day) DO UPDATE SET
				count = entitlement_daily_counters.count + 1,
				updated_at = excluded.updated_at
			WHERE entitlement_daily_counters.count + 1 <= ?`,
		)
		.bind(
			input.userId,
			input.resource,
			utcDayKey(now),
			now.toISOString(),
			limit,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) {
		await throwLimitError()
	}
}

export const defaultWorkflowConcurrencyBackstop = 100

/**
 * Global per-user concurrent workflow backstop for users without a plan.
 * Reads the WORKFLOW_CONCURRENT_LIMIT env var (previously read directly by
 * package-workflows.ts) and falls back to the historical default of 100.
 */
export function getWorkflowConcurrencyBackstop(env: {
	WORKFLOW_CONCURRENT_LIMIT?: string
}) {
	const raw = env.WORKFLOW_CONCURRENT_LIMIT
	if (typeof raw !== 'string') return defaultWorkflowConcurrencyBackstop
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: defaultWorkflowConcurrencyBackstop
}
