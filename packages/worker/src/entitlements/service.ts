import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	createStableUserIdFromEmail,
	findUserRowByStableUserId,
	isMissingStableUserIdColumnError,
	resolveUserStableId,
} from '#worker/user-id.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { EntitlementLimitError, buildEntitlementUpgradeHint } from './errors.ts'
import {
	parsePlanName,
	resolveEffectivePlan,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'

/**
 * Resolve the effective plan for a user, or null when the user is
 * legacy/unlimited.
 *
 * The MCP `userId` is the account's stored stable id, falling back to the
 * legacy SHA-256 email hash when a stored id has not been materialized yet.
 * The lookup goes through email while verifying that the account stable id
 * matches the given userId. When the pair does not match (synthetic
 * runtime contexts, package-scoped caller contexts with an empty email, or
 * test fixtures), the lookup short-circuits to null without touching D1 —
 * which also means enforcement is skipped, matching the invariant that
 * enforcement only activates for users with a verified plan.
 *
 * Effective plan = f(manual users.plan, users.stripe_plan): a NULL manual
 * plan always wins (legacy/unlimited); otherwise the higher-ranked of the
 * manual grant and Stripe subscription plan is returned. Signature stays
 * `(db, { userId, email })` so enforcement call sites are unchanged.
 */
export async function getUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName | null> {
	const email = input.email?.trim().toLowerCase()
	if (!email || !input.userId) return null
	if ((await createStableUserIdFromEmail(email)) !== input.userId) {
		if (!/^[a-f0-9]{64}$/i.test(input.userId)) return null
		// Only the missing-column case (pre-migration databases and legacy
		// test fixtures) may be treated as "no stored plan"; any other D1
		// failure must propagate instead of silently disabling enforcement.
		const storedMatch = await db
			.prepare(
				`SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`,
			)
			.bind(email, input.userId)
			.first<{ plan: string | null; stripe_plan: string | null }>()
			.catch((error: unknown) => {
				if (isMissingStableUserIdColumnError(error)) return null
				throw error
			})
		return storedMatch
			? resolveEffectivePlan(
					parsePlanName(storedMatch.plan),
					storedMatch.stripe_plan,
				)
			: null
	}
	const row = await db
		.prepare(`SELECT plan, stripe_plan FROM users WHERE email = ?`)
		.bind(email)
		.first<{ plan: string | null; stripe_plan: string | null }>()
	if (!row) return null
	return resolveEffectivePlan(parsePlanName(row.plan), row.stripe_plan)
}

/**
 * Per-isolate cache of stable user id → account email. Cache hits are
 * validated against the stored stable id and deleted entries fall back to a
 * fresh scan. Bounded so long-lived isolates cannot grow it without limit;
 * the oldest insertion is evicted first.
 */
const stableUserIdEmailCache = new Map<string, string>()
const stableUserIdEmailCacheMaxEntries = 256

function cacheStableUserIdEmail(stableUserId: string, email: string) {
	if (stableUserIdEmailCache.size >= stableUserIdEmailCacheMaxEntries) {
		const oldestKey = stableUserIdEmailCache.keys().next().value
		if (oldestKey !== undefined) stableUserIdEmailCache.delete(oldestKey)
	}
	stableUserIdEmailCache.set(stableUserId, email)
}

export type StableUserAccount = {
	email: string
	plan: PlanName | null
	/** Whether users.email_verified_at is set. Read fresh, never cached. */
	emailVerified: boolean
}

/**
 * Reverse-resolve a stable MCP userId back to the account email, plan, and
 * verified-email state. Stored stable ids are one indexed point read; legacy
 * rows without one fall back to the scan in `findUserRowByStableUserId`,
 * which hashes each email and writes the computed id back so the scan is
 * paid at most once per row.
 * Only call this on paths that genuinely have no caller context email (for
 * example package-runtime contexts acting with only the hashed userId);
 * inbound email routing resolves accounts via the indexed username lookup
 * and interactive surfaces already carry the email.
 */
export async function findUserAccountByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<StableUserAccount | null> {
	const trimmed = stableUserId.trim()
	if (!trimmed) return null
	const cachedEmail = stableUserIdEmailCache.get(trimmed)
	if (cachedEmail) {
		const row = await db
			.prepare(
				`SELECT email, stable_user_id, plan, email_verified_at
				 FROM users
				 WHERE email = ?`,
			)
			.bind(cachedEmail)
			.first<{
				email: string
				stable_user_id: string | null
				plan: string | null
				email_verified_at: string | null
			}>()
			.catch(async (error: unknown) => {
				// Only a schema missing the stable_user_id column downgrades to the
				// legacy query; transient D1 failures must propagate, not silently
				// change which lookup ran.
				if (!isMissingStableUserIdColumnError(error)) throw error
				const legacyRow = await db
					.prepare(
						`SELECT email, plan, email_verified_at
						 FROM users
						 WHERE email = ?`,
					)
					.bind(cachedEmail)
					.first<{
						email: string
						plan: string | null
						email_verified_at: string | null
					}>()
				return legacyRow
					? { ...legacyRow, stable_user_id: null as string | null }
					: null
			})
		if (row && (await resolveUserStableId(row)) === trimmed) {
			return {
				email: row.email,
				plan: parsePlanName(row.plan),
				emailVerified: Boolean(row.email_verified_at),
			}
		}
		// The account is gone (deleted); drop the entry and rescan.
		stableUserIdEmailCache.delete(trimmed)
	}
	const row = await findUserRowByStableUserId<{
		id: number
		email: string
		stable_user_id: string | null
		plan: string | null
		email_verified_at: string | null
	}>({
		db,
		stableUserId: trimmed,
		select: `SELECT id, email, stable_user_id, plan, email_verified_at FROM users`,
	})
	if (!row) return null
	cacheStableUserIdEmail(trimmed, row.email)
	return {
		email: row.email,
		plan: parsePlanName(row.plan),
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
					'run_history_json',
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
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'package_id',
					'package_kody_id',
					'source_id',
					'published_commit',
					'name',
					'error_name',
					'error_message',
					'storage_id',
					'job_id',
					'workflow_id',
					'invocation_id',
					'session_id',
					'idempotency_key',
					'parent_run_id',
					'metadata_json',
				])}
			), 0) AS count
			FROM package_runtime_runs
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'package_id',
					'level',
					'message',
					'fields_json',
				])}
			), 0) AS count
			FROM package_runtime_logs
			WHERE user_id = ?`,
			[userId],
		),
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
 * Recency window for counting running package services. Service runs are
 * tracked in package_runtime_runs; rows can be left in 'running' after a
 * hard eviction, so stale rows older than this window are ignored to avoid
 * permanently locking a user out of their quota.
 */
const runningServiceCountWindowMs = 24 * 60 * 60 * 1000

/**
 * Count distinct recently-running package services for a user. Enforcement
 * points that start a specific service should pass `excludeService` so a
 * stale 'running' row for that same service can never block its own
 * restart (starting it again does not add a new running service).
 */
export async function countRunningPackageServices(input: {
	db: D1Database
	userId: string
	excludeService?: { packageId: string; serviceName: string }
	now?: Date
}): Promise<number> {
	const now = input.now ?? new Date()
	const windowStart = new Date(
		now.valueOf() - runningServiceCountWindowMs,
	).toISOString()
	const exclusion = input.excludeService
		? `AND NOT (package_id = ? AND COALESCE(name, '') = ?)`
		: ''
	const params: Array<unknown> = [input.userId, windowStart]
	if (input.excludeService) {
		params.push(
			input.excludeService.packageId,
			input.excludeService.serviceName,
		)
	}
	return await countRows(
		input.db,
		`SELECT COUNT(DISTINCT package_id || '/' || COALESCE(name, '')) AS count
		FROM package_runtime_runs
		WHERE user_id = ?
			AND surface = 'service'
			AND status = 'running'
			AND started_at >= ?
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
		case 'email_receives_per_day':
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
 *
 * Users without a plan (or without a resolvable limit) consume without a
 * cap: the counter still accumulates so limits bind the moment a plan is
 * assigned. Pass `fallbackLimit` to cap plan-less users with a
 * deployment-level backstop (for example inbound email receives).
 */
export async function consumeDailyEntitlement(input: {
	db: D1Database
	userId: string
	email: string | null | undefined
	resource: EntitlementResource
	/**
	 * Limit that applies when the user has no plan. Default: no limit for
	 * plan-less users (the counter still accumulates).
	 */
	fallbackLimit?: number | null
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	const plan = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = plan
		? resolvePlanLimit(plan, input.resource)
		: (input.fallbackLimit ?? null)
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
