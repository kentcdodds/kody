import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { EntitlementLimitError, buildEntitlementUpgradeHint } from './errors.ts'
import {
	parseStoredPlanName,
	resolveEffectivePlan,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'

const stableUserIdPattern = /^[a-f0-9]{64}$/i

/**
 * Resolve the effective plan for a user. Always returns a {@link PlanName}
 * (never a meaningful null): missing email/userId, invalid stable ids, and
 * no matching row resolve to `max` without warning; stored values go through
 * {@link parseStoredPlanName} (unknown / defensive NULL / residual
 * `'unlimited'` → `max` with a stable warn tag).
 *
 * The MCP `userId` is the account's stored `users.stable_user_id`. Lookup
 * requires the email + stable id pair so a mismatched caller context
 * (synthetic runtime contexts, package-scoped callers with an empty email, or
 * test fixtures) cannot resolve another account's plan. Non-hex userIds
 * short-circuit without touching D1.
 *
 * Effective plan = f(manual users.plan, users.stripe_plan): the higher-ranked
 * of the manual grant and Stripe subscription plan is returned (`max` ranks
 * highest). Signature stays `(db, { userId, email })` so enforcement call
 * sites are unchanged.
 */
export async function getUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName> {
	const email = input.email?.trim().toLowerCase()
	if (!email || !input.userId) return 'max'
	if (!stableUserIdPattern.test(input.userId)) return 'max'
	const row = await db
		.prepare(
			`SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`,
		)
		.bind(email, input.userId)
		.first<{ plan: string; stripe_plan: string | null }>()
	if (!row) return 'max'
	return resolveEffectivePlan(parseStoredPlanName(row.plan), row.stripe_plan)
}

export type StableUserAccount = {
	email: string
	plan: PlanName
	/** Whether users.email_verified_at is set. */
	emailVerified: boolean
}

/**
 * Reverse-resolve a stable MCP userId back to the account email, plan, and
 * verified-email state via one indexed `users.stable_user_id` point read.
 * Only call this on paths that genuinely have no caller context email (for
 * example package-runtime contexts acting with only the stable userId);
 * inbound email routing resolves accounts via the indexed username lookup
 * and interactive surfaces already carry the email.
 */
export async function findUserAccountByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<StableUserAccount | null> {
	const trimmed = normalizeStableUserId(stableUserId)
	if (!trimmed) return null
	const row = await db
		.prepare(
			`SELECT email, plan, email_verified_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(trimmed)
		.first<{
			email: string
			plan: string
			email_verified_at: string | null
		}>()
	if (!row) return null
	return {
		email: row.email,
		plan: parseStoredPlanName(row.plan),
		emailVerified: Boolean(row.email_verified_at),
	}
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

const entitlementByteEncoder = new TextEncoder()

function utf8ByteLength(value: string) {
	return entitlementByteEncoder.encode(value).byteLength
}

function serializeByteEstimateValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === undefined) return 'undefined'
	try {
		return JSON.stringify(value) ?? 'null'
	} catch {
		return String(value)
	}
}

export function estimateEntitlementStorageBytes(value: unknown): number {
	return utf8ByteLength(serializeByteEstimateValue(value))
}

export function estimateEntitlementStorageEntryBytes(input: {
	key?: string | null
	value: unknown
}) {
	return (
		(input.key ? estimateEntitlementStorageBytes(input.key) : 0) +
		estimateEntitlementStorageBytes(input.value)
	)
}

export function estimateEntitlementStorageByteDelta(input: {
	nextBytes: number
	existingBytes?: number | null
}) {
	return Math.max(0, input.nextBytes - (input.existingBytes ?? 0))
}

export function estimateEntitlementStorageEntryByteDelta(input: {
	next: { key?: string | null; value: unknown }
	existing?: { key?: string | null; value: unknown } | null
}) {
	return estimateEntitlementStorageByteDelta({
		nextBytes: estimateEntitlementStorageEntryBytes(input.next),
		existingBytes: input.existing
			? estimateEntitlementStorageEntryBytes(input.existing)
			: 0,
	})
}

export function estimateEntitlementStorageSqlWriteBytes(input: {
	query: string
	params?: Array<unknown>
}) {
	return estimateEntitlementStorageEntryBytes({
		value: {
			query: input.query,
			params: input.params ?? [],
		},
	})
}

function textBytesExpression(columns: ReadonlyArray<string>) {
	return columns
		.map((column) => `length(CAST(COALESCE(${column}, '') AS BLOB))`)
		.join(' + ')
}

function isMissingStorageByteSurfaceError(error: unknown) {
	return (
		error instanceof Error && /\bno such (table|column)\b/i.test(error.message)
	)
}

async function sumStorageBytes(
	db: D1Database,
	sql: string,
	params: Array<unknown>,
) {
	const row = await db
		.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
		.catch((error: unknown) => {
			if (isMissingStorageByteSurfaceError(error)) return null
			throw error
		})
	return Number(row?.count ?? 0)
}

export async function readUserD1StorageBytes(input: {
	db: D1Database
	userId: string
}) {
	const { db, userId } = input
	const sums = await Promise.all([
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				COALESCE(raw_size, 0)
				+ ${textBytesExpression([
					'from_address',
					'envelope_from',
					'to_addresses_json',
					'cc_addresses_json',
					'bcc_addresses_json',
					'reply_to_addresses_json',
					'subject',
					'message_id_header',
					'in_reply_to_header',
					'references_json',
					'headers_json',
					'auth_results',
					'text_body',
					'html_body',
					'provider_message_id',
					'error',
				])}
			), 0) AS count
			FROM email_messages
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(size), 0) AS count
			FROM email_attachments ea
			JOIN email_messages em ON em.id = ea.message_id
			WHERE em.user_id = ? AND ea.storage_kind = 'external'`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression(['ve.name', 've.description', 've.value'])}
			), 0) AS count
			FROM value_entries ve
			JOIN value_buckets vb ON vb.id = ve.bucket_id
			WHERE vb.user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'se.name',
					'se.description',
					'se.encrypted_value',
					'se.allowed_hosts',
					'se.allowed_capabilities',
					'se.allowed_packages',
				])}
			), 0) AS count
			FROM secret_entries se
			JOIN secret_buckets sb ON sb.id = se.bucket_id
			WHERE sb.user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'category',
					'subject',
					'summary',
					'details',
					'tags_json',
					'source_uris_json',
					'dedupe_key',
				])}
			), 0) AS count
			FROM mcp_memories
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'name',
					'kody_id',
					'description',
					'tags_json',
					'search_text',
					'source_id',
				])}
			), 0) AS count
			FROM saved_packages
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'name',
					'params_json',
					'schedule_json',
					'timezone',
					'caller_context_json',
					'last_run_status',
					'last_run_error',
					'source_id',
					'published_commit',
					'storage_id',
				])}
			), 0) AS count
			FROM jobs
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'entity_kind',
					'entity_id',
					'repo_id',
					'published_commit',
					'indexed_commit',
					'manifest_path',
					'source_root',
				])}
			), 0) AS count
			FROM entity_sources
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'source_id',
					'source_repo_id',
					'session_branch',
					'source_branch',
					'base_commit',
					'source_root',
					'conversation_id',
					'last_checkpoint_commit',
					'last_check_run_id',
					'last_check_tree_hash',
				])}
			), 0) AS count
			FROM repo_sessions
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'token_id',
					'package_id',
					'package_kody_id',
					'export_name',
					'idempotency_key',
					'request_hash',
					'source',
					'topic',
					'response_json',
				])}
			), 0) AS count
			FROM package_invocations
			WHERE user_id = ?`,
			[userId],
		),
		// Run records are observability history, not user content, and now live
		// in a per-user RunLog Durable Object. They are intentionally excluded
		// from the storage quota.
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'source_id',
					'artifact_kind',
					'artifact_name',
					'entry_point',
					'published_commit',
					'kv_key',
					'dependencies_json',
				])}
			), 0) AS count
			FROM published_bundle_artifacts
			WHERE user_id = ?`,
			[userId],
		),
	])
	return sums.reduce((total, value) => total + value, 0)
}

/**
 * Staleness threshold for counting a `package_service_states` row as running.
 *
 * This is not the old history-table hack relocated. `package_service_states`
 * is an authoritative state projection that Durable Objects upsert on
 * lifecycle transitions and actively heartbeat (refreshing `updated_at`)
 * while a service is alive. A hard DO eviction that never restores should
 * clear the row on restore; the threshold is defense-in-depth for the case
 * where the DO never comes back and the best-effort D1 write did not land.
 * Heartbeats keep live services well inside this window.
 */
export const packageServiceStateStaleMs = 24 * 60 * 60 * 1000

/**
 * Count currently-running package services for a user from
 * `package_service_states`. Enforcement points that start a specific service
 * should pass `excludeService` so a stale 'running' row for that same
 * service can never block its own restart (starting it again does not add a
 * new running service).
 */
export async function countRunningPackageServices(input: {
	db: D1Database
	userId: string
	excludeService?: { packageId: string; serviceName: string }
	now?: Date
}): Promise<number> {
	const now = input.now ?? new Date()
	const freshAfter = new Date(
		now.valueOf() - packageServiceStateStaleMs,
	).toISOString()
	const exclusion = input.excludeService
		? `AND NOT (package_id = ? AND service_name = ?)`
		: ''
	const params: Array<unknown> = [input.userId, freshAfter]
	if (input.excludeService) {
		params.push(
			input.excludeService.packageId,
			input.excludeService.serviceName,
		)
	}
	return await countRows(
		input.db,
		`SELECT COUNT(*) AS count
		FROM package_service_states
		WHERE user_id = ?
			AND status = 'running'
			AND updated_at >= ?
			${exclusion}`,
		params,
	)
}

export async function readEntitlementResourceUsage(input: {
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
			return await countRunningPackageServices({
				db,
				userId,
				now,
			})
		}
		case 'persistent_package_services':
			// Finite 0/1 gate: the limit is 0 (not allowed) or 1 (allowed),
			// so the current count never changes the outcome.
			return 0
		case 'repo_sessions':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM repo_sessions
				WHERE user_id = ? AND status = 'active'`,
				[userId],
			)
		case 'email_sends_per_day':
		case 'email_receives_per_day':
		case 'execute_calls_per_day':
		case 'outbound_fetches_per_day':
			return await readDailyEntitlementCounter({
				db,
				userId,
				resource,
				now,
			})
		case 'stored_email_messages':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM email_messages WHERE user_id = ?`,
				[userId],
			)
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
			return await readUserD1StorageBytes({ db, userId })
		case 'email_message_bytes':
			// Per-message limit, not an accumulating counter: enforcement
			// passes the candidate message size via getCurrent.
			throw new Error(
				'email_message_bytes has no built-in counter; pass getCurrent to assertWithinEntitlement.',
			)
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}

export async function assertWithinStorageBytesEntitlement(input: {
	db: D1Database
	userId: string
	email: string | null | undefined
	requested?: number
	getCurrent?: () => Promise<number>
}) {
	await assertWithinEntitlement({
		db: input.db,
		userId: input.userId,
		email: input.email,
		resource: 'storage_bytes',
		requested: input.requested,
		getCurrent: input.getCurrent,
	})
}

export type AssertWithinEntitlementInput = {
	db: D1Database
	userId: string
	/**
	 * Account email of the acting user when available. Plan lookup requires
	 * the email + stable-id pair; when absent (synthetic runtime contexts)
	 * {@link getUserPlan} resolves to `max`.
	 */
	email: string | null | undefined
	resource: EntitlementResource
	/** How many units the operation is about to consume. Defaults to 1. */
	requested?: number
	/** Override the built-in D1 usage counter for this resource. */
	getCurrent?: () => Promise<number>
	now?: Date
}

/**
 * The single enforcement helper. Every entitlement enforcement point calls
 * this and lets the thrown EntitlementLimitError propagate unchanged so the
 * error shape and user-facing message stay identical across MCP and UI
 * surfaces. Every resolved plan has finite numeric limits.
 */
export async function assertWithinEntitlement(
	input: AssertWithinEntitlementInput,
): Promise<void> {
	const plan = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = resolvePlanLimit(plan, input.resource)
	const now = input.now ?? new Date()
	const requested = input.requested ?? 1
	const current = input.getCurrent
		? await input.getCurrent()
		: await readEntitlementResourceUsage({
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
 * Every resolved plan has finite numeric limits.
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
	const limit = resolvePlanLimit(plan, input.resource)
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

/**
 * Atomically refund one previously consumed daily entitlement unit for the
 * given user/resource/UTC day (floors at zero). Scoped by `user_id` so a
 * refund can never touch another user's counter. Used when inbound receive
 * quota was charged before a retryable storage failure — the same `now`
 * (day key) as the matching `consumeDailyEntitlement` call must be passed.
 */
export async function refundDailyEntitlement(input: {
	db: D1Database
	userId: string
	resource: EntitlementResource
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`UPDATE entitlement_daily_counters
			SET count = MAX(0, count - 1),
				updated_at = ?
			WHERE user_id = ?
				AND resource = ?
				AND day = ?`,
		)
		.bind(now.toISOString(), input.userId, input.resource, utcDayKey(now))
		.run()
}
