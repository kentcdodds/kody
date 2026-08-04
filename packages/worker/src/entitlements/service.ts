import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import { countActiveWorkflowProjections } from '#worker/run-records/service.ts'
import { countInternalUserEmailMessages } from '#worker/email/mailbox-internal-read.ts'
import { EntitlementLimitError, buildEntitlementUpgradeHint } from './errors.ts'
import {
	parseStoredPlanName,
	resolveEffectivePlan,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'
import {
	isDailyEntitlementResource,
	type DailyEntitlementResource,
} from './user-meter-do.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from './user-meter-client.ts'

/** Env surface for authoritative entitlement usage readers. */
export type EntitlementUsageEnv = UserMeterEnv &
	Pick<Env, 'RUN_LOG' | 'MAILBOX'>

const stableUserIdPattern = /^[a-f0-9]{64}$/i

/**
 * Resolve the effective plan for a user. Always returns a {@link PlanName}
 * (never a meaningful null): missing userId, invalid stable ids, and no
 * matching row resolve to `free` without warning; stored values go through
 * strict {@link parseStoredPlanName} validation and throw if D1 violates the
 * plan CHECK constraint.
 *
 * The MCP `userId` is the account's stored `users.stable_user_id`. When an
 * email is provided, lookup requires the email + stable id pair so a
 * mismatched caller context cannot resolve another account's plan. When email
 * is absent (package-job / workflow / webhook contexts that persist
 * `email: ''`), reverse-resolve by stable userId alone so those paths enforce
 * the account's real plan instead of silently using `free`. Non-hex userIds
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
	if (!input.userId) return 'free'
	if (!stableUserIdPattern.test(input.userId)) return 'free'
	const row = email
		? await db
				.prepare(
					`SELECT plan, stripe_plan FROM users WHERE email = ? AND stable_user_id = ?`,
				)
				.bind(email, input.userId)
				.first<{ plan: string; stripe_plan: string | null }>()
		: await db
				.prepare(`SELECT plan, stripe_plan FROM users WHERE stable_user_id = ?`)
				.bind(input.userId)
				.first<{ plan: string; stripe_plan: string | null }>()
	if (!row) return 'free'
	return resolveEffectivePlan(parseStoredPlanName(row.plan), row.stripe_plan)
}

export type StableUserAccount = {
	email: string
	plan: PlanName
	/** Whether users.email_verified_at is set. */
	emailVerified: boolean
}

/**
 * Short-TTL caches for the plan / account lookups that run on metered hot
 * paths (every execute call and every sandbox outbound fetch pays one). The
 * quota counter write itself stays atomic and uncached; only the plan-limit
 * resolution tolerates staleness, so a plan change takes effect for quota
 * checks within {@link entitlementLookupCacheTtlMs} instead of immediately.
 * Keyed by the `D1Database` binding so test databases never share entries.
 */
const entitlementLookupCacheTtlMs = 60_000
const entitlementLookupCacheMaxEntries = 1_000

type EntitlementLookupCacheEntry<T> = {
	value: Promise<T>
	expiresAtMs: number
}

function createEntitlementLookupCache<T>() {
	const cachesByDb = new WeakMap<
		D1Database,
		Map<string, EntitlementLookupCacheEntry<T>>
	>()
	return {
		async getOrCreate(
			db: D1Database,
			key: string,
			create: () => Promise<T>,
		): Promise<T> {
			let cache = cachesByDb.get(db)
			if (!cache) {
				cache = new Map()
				cachesByDb.set(db, cache)
			}
			const nowMs = Date.now()
			const existing = cache.get(key)
			if (existing && existing.expiresAtMs > nowMs) {
				return await existing.value
			}
			const value = create()
			// Never cache failures: a D1 blip must not pin an error for the TTL.
			value.catch(() => {
				if (cache.get(key)?.value === value) cache.delete(key)
			})
			if (cache.size >= entitlementLookupCacheMaxEntries) {
				const oldestKey = cache.keys().next().value
				if (oldestKey !== undefined) cache.delete(oldestKey)
			}
			cache.set(key, {
				value,
				expiresAtMs: nowMs + entitlementLookupCacheTtlMs,
			})
			return await value
		},
	}
}

const cachedUserPlans = createEntitlementLookupCache<PlanName>()
const cachedStableUserAccounts =
	createEntitlementLookupCache<StableUserAccount | null>()

/**
 * {@link getUserPlan} behind the short-TTL hot-path cache. Use only where a
 * plan change may take up to a minute to apply (quota limit resolution);
 * interactive plan displays should keep calling {@link getUserPlan}.
 */
export async function getCachedUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName> {
	const email = input.email?.trim().toLowerCase()
	if (!input.userId) return 'free'
	if (!stableUserIdPattern.test(input.userId)) return 'free'
	// Empty email is a distinct cache key from any concrete email; both paths
	// share getUserPlan's reverse-resolve / pair-match semantics.
	return await cachedUserPlans.getOrCreate(
		db,
		`${input.userId}\n${email ?? ''}`,
		async () => await getUserPlan(db, input),
	)
}

/**
 * {@link findUserAccountByStableUserId} behind the short-TTL hot-path cache,
 * for per-fetch account reverse-resolution in the fetch gateway.
 */
export async function findCachedUserAccountByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<StableUserAccount | null> {
	const trimmed = normalizeStableUserId(stableUserId)
	if (!trimmed) return null
	return await cachedStableUserAccounts.getOrCreate(
		db,
		trimmed,
		async () => await findUserAccountByStableUserId(db, trimmed),
	)
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

function assertDailyEntitlementResource(
	resource: EntitlementResource,
): DailyEntitlementResource {
	if (!isDailyEntitlementResource(resource)) {
		throw new Error(
			`Expected a daily entitlement resource; got ${JSON.stringify(resource)}.`,
		)
	}
	return resource
}

/**
 * Seed a missing UserMeter `(resource, day)` at zero. `INSERT OR IGNORE`
 * inside the DO keeps concurrent cold callers safe.
 */
async function ensureUserMeterCounterInitializedAtZero(input: {
	env: UserMeterEnv
	userId: string
	resource: DailyEntitlementResource
	day: string
	updatedAt: string
}) {
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	await meter.initialize({
		resource: input.resource,
		day: input.day,
		count: 0,
		updatedAt: input.updatedAt,
	})
}

/**
 * Point-read one daily entitlement counter from UserMeter. Cold meters
 * initialize the `(resource, day)` at zero, then re-read; warm meters return
 * the DO count. Never touches D1 daily counter state.
 *
 * `db` remains on the signature for call-site stability; plan/account lookups
 * on other paths still need APP_DB.
 */
export async function readDailyEntitlementResourceUsage(input: {
	db: D1Database
	env: UserMeterEnv
	userId: string
	resource: EntitlementResource
	now?: Date
}): Promise<number> {
	void input.db
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await meter.read({
		resource,
		day,
		now: updatedAt,
	})
	if (result.outcome === 'needs_bootstrap') {
		await ensureUserMeterCounterInitializedAtZero({
			env: input.env,
			userId: input.userId,
			resource,
			day,
			updatedAt,
		})
		result = await meter.read({
			resource,
			day,
			now: updatedAt,
		})
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter daily entitlement read still needs bootstrap after initialize.',
			)
		}
	}
	return result.count
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

/**
 * Authoritative D1 payload scan. This is intentionally reserved for migration
 * backfills and the bounded reconciliation lane; entitlement checks must use
 * the stored point-read counter below.
 */
export async function calculateUserD1StorageBytes(input: {
	db: D1Database
	userId: string
}) {
	const { db, userId } = input
	const sums = await Promise.all([
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
		// Run records and the keyed package-invocation idempotency ledger live
		// in the per-user RunLog Durable Object (the D1 package_invocations
		// table was dropped). Both are self-expiring operational state, not
		// user content, and are intentionally excluded from the storage quota.
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
 * Whether a real account row exists for this stable user id. Synthetic
 * contexts (no `users` row) must never materialize durable UserMeter state.
 */
async function userAccountRowExists(input: {
	db: D1Database
	userId: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(`SELECT 1 AS present FROM users WHERE stable_user_id = ?`)
		.bind(input.userId)
		.first<{ present: number }>()
	return row != null
}

/**
 * Recompute one user's authoritative storage bytes from D1 payload tables
 * (physical source of truth) and set UserMeter via a revision-guarded CAS.
 *
 * Flow:
 * 1. Read current UserMeter revision BEFORE computing the physical sum.
 * 2. Compute the physical sum from D1 payload tables.
 * 3a. If the meter was missing (`needs_bootstrap`): initialize it. If another
 *    caller already created the singleton, defer to the next sweep (their
 *    state is correct; do not overwrite).
 * 3b. If the meter was present: CAS with the captured revision. A concurrent
 *    reserve that bumped the revision causes a CAS miss → defer to next sweep.
 *
 * Returns `{ bytes, updated, deferred }`. `deferred` is true when a CAS miss
 * or init race prevented the write; the row should be rotated for retry.
 * `deferred` is never a failure and is not counted as `updated`.
 */
export async function reconcileUserD1StorageBytes(input: {
	db: D1Database
	userId: string
	now?: Date
	/** Required: UserMeter is authoritative after the cutover. */
	env: UserMeterEnv
}): Promise<{ bytes: number; updated: boolean; deferred: boolean }> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })

	// Step 1: Capture meter revision BEFORE computing physical sum.
	const currentState = await meter.readStorageBytes()

	if (currentState.outcome === 'needs_bootstrap') {
		// Cold init path: compute physical sum and initialize the singleton.
		const bytes = await calculateUserD1StorageBytes(input)
		const initResult = await meter.initializeStorageBytes({
			bytes,
			updatedAt: nowIso,
		})
		if (!initResult.created) {
			// Init race: another caller created the singleton between read and
			// initializeStorageBytes; do not overwrite their state. Defer.
			return { bytes, updated: false, deferred: true }
		}
		return { bytes, updated: true, deferred: false }
	}

	// Step 2: Capture the revision from the pre-computation read.
	const capturedRevision = currentState.revision

	// Step 3: Compute physical sum AFTER capturing revision.
	const bytes = await calculateUserD1StorageBytes(input)

	// Step 4: CAS — apply only when revision still matches.
	const casResult = await meter.reconcileStorageBytes({
		bytes,
		expectedRevision: capturedRevision,
		updatedAt: nowIso,
	})

	if (casResult.outcome === 'needs_bootstrap') {
		// Meter was purged between read and CAS (e.g. account deletion).
		// Defer so the next sweep can re-initialize cleanly.
		return { bytes, updated: false, deferred: true }
	}

	if (!casResult.applied) {
		// CAS miss: a concurrent reserve bumped the revision between capture and
		// CAS. Do not overwrite — defer to next sweep when the meter is quiet.
		return { bytes, updated: false, deferred: true }
	}

	return { bytes, updated: true, deferred: false }
}

/**
 * Keyset sweep page for the reconcile lane. The platform-owned
 * `d1_storage_reconcile_cursor` singleton stores the last processed stable
 * user id; pages walk `users.stable_user_id` ascending and wrap to the start
 * when the tail is reached. No per-user cursor state exists.
 */
export async function listUsersForD1StorageReconciliation(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ userId: string }>> {
	const cursorRow = await input.db
		.prepare(
			`SELECT position FROM d1_storage_reconcile_cursor
			WHERE singleton = 1`,
		)
		.first<{ position: string }>()
	const lastUserId = cursorRow?.position ?? ''
	const page = await input.db
		.prepare(
			`SELECT stable_user_id AS userId
			FROM users
			WHERE stable_user_id > ?
			ORDER BY stable_user_id ASC
			LIMIT ?`,
		)
		.bind(lastUserId, input.limit)
		.all<{ userId: string }>()
	const rows = page.results ?? []
	if (rows.length > 0 || lastUserId === '') return rows
	// Tail reached: wrap to the start of the keyset for the next full sweep.
	const wrapped = await input.db
		.prepare(
			`SELECT stable_user_id AS userId
			FROM users
			ORDER BY stable_user_id ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<{ userId: string }>()
	return wrapped.results ?? []
}

/** Advance the reconcile-lane keyset cursor past the processed page. */
export async function advanceD1StorageReconciliationCursor(input: {
	db: D1Database
	lastUserId: string
	now?: Date
}) {
	await input.db
		.prepare(
			`UPDATE d1_storage_reconcile_cursor
			SET position = ?, updated_at = ?
			WHERE singleton = 1`,
		)
		.bind(input.lastUserId, (input.now ?? new Date()).toISOString())
		.run()
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
 * Count currently-running package services for a user directly from D1
 * `package_service_states`. Reserved for parity comparisons only — enforcement
 * uses the UserMeter-authoritative `countRunningPackageServices`.
 */
export async function countRunningPackageServicesFromD1(input: {
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

/**
 * UserMeter-authoritative running count for a user's package services.
 * Reads directly from the DO; no D1 access. Lifecycle dual-writes
 * (`upsertPackageServiceState`) populate the meter so enforcement is
 * immediately consistent. The `excludeService` and 24h staleness semantics
 * are preserved exactly.
 *
 * Requires `env.USER_METER`. Throws immediately when the binding is absent
 * (fail-closed for enforcement).
 */
export async function countRunningPackageServices(input: {
	env: UserMeterEnv
	userId: string
	excludeService?: { packageId: string; serviceName: string }
	now?: Date
}): Promise<number> {
	const now = input.now ?? new Date()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const { count } = await meter.countRunningPackageServices({
		staleAfterMs: packageServiceStateStaleMs,
		excludeService: input.excludeService,
		now: now.toISOString(),
	})
	return count
}

export async function readEntitlementResourceUsage(input: {
	db: D1Database
	userId: string
	resource: EntitlementResource
	now: Date
}): Promise<number> {
	const { db, userId, resource, now } = input
	switch (resource) {
		case 'repos':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM user_repos WHERE user_id = ?`,
				[userId],
			)
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
		case 'package_services':
			// Authoritative running liveness is in UserMeter. Callers must use
			// readCurrentEntitlementResourceUsage or pass getCurrent with
			// countRunningPackageServices to assertWithinEntitlement.
			throw new Error(
				'package_services usage must be read from UserMeter (use readCurrentEntitlementResourceUsage or pass getCurrent with countRunningPackageServices).',
			)
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
			// Authoritative daily counters live in UserMeter. Callers must use
			// consumeDailyEntitlement / readDailyEntitlementResourceUsage /
			// readCurrentEntitlementResourceUsage — the retired D1 mirror is gone.
			throw new Error(
				`${resource} usage must be read from UserMeter (use readDailyEntitlementResourceUsage or readCurrentEntitlementResourceUsage).`,
			)
		case 'stored_email_messages':
			throw new Error(
				'stored_email_messages usage must be read from Mailbox (use readCurrentEntitlementResourceUsage).',
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
		case 'concurrent_workflows':
			// Authoritative concurrent-workflow occupancy lives in per-user
			// RunLog `workflow_projections`. Callers must pass getCurrent from
			// reserveWorkflowProjectionSlot (create path) or use
			// readCurrentEntitlementResourceUsage (usage readers).
			throw new Error(
				'concurrent_workflows usage must be read from RunLog (pass getCurrent or use readCurrentEntitlementResourceUsage).',
			)
		case 'storage_bytes':
			// Authoritative storage bytes live in UserMeter. Callers must use
			// readCurrentEntitlementResourceUsage (which reads UserMeter with
			// cold bootstrap) or assertWithinStorageBytesEntitlement (DO
			// reserve); calculateUserD1StorageBytes is the physical recompute
			// used by cold bootstrap and the reconcile lane.
			throw new Error(
				'storage_bytes usage must be read from UserMeter (use readCurrentEntitlementResourceUsage).',
			)
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

/**
 * Read current storage bytes from UserMeter with cold bootstrap. On
 * `needs_bootstrap`, zero-initializes the singleton (matching the daily
 * counter cold path) and retries. The bounded reconcile lane recomputes
 * physical D1 payload bytes and corrects any drift via CAS. Always returns
 * the authoritative DO byte count.
 */
export async function readStorageBytesFromUserMeter(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: string
	now: Date
}): Promise<number> {
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await meter.readStorageBytes()
	if (result.outcome === 'needs_bootstrap') {
		// Synthetic/unknown contexts have no account row. Preserve their zero
		// usage semantics without materializing durable state for a non-user.
		if (!(await userAccountRowExists(input))) return 0
		await meter.initializeStorageBytes({
			bytes: 0,
			updatedAt: input.now.toISOString(),
		})
		result = await meter.readStorageBytes()
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter storage bytes read still needs bootstrap after initialize.',
			)
		}
	}
	return result.bytes
}

/**
 * Authoritative current usage for any entitlement resource: daily counters
 * via UserMeter, concurrent workflows via RunLog workflow projections, and
 * everything else via the legacy D1 helpers.
 */
export async function readCurrentEntitlementResourceUsage(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: string
	resource: EntitlementResource
	now: Date
}): Promise<number> {
	if (isDailyEntitlementResource(input.resource)) {
		return await readDailyEntitlementResourceUsage({
			db: input.db,
			env: input.env,
			userId: input.userId,
			resource: input.resource,
			now: input.now,
		})
	}
	if (input.resource === 'concurrent_workflows') {
		return await countActiveWorkflowProjections({
			env: input.env as Env,
			userId: input.userId,
		})
	}
	if (input.resource === 'storage_bytes') {
		return await readStorageBytesFromUserMeter({
			db: input.db,
			env: input.env,
			userId: input.userId,
			now: input.now,
		})
	}
	if (input.resource === 'package_services') {
		return await countRunningPackageServices({
			env: input.env,
			userId: input.userId,
			now: input.now,
		})
	}
	if (input.resource === 'stored_email_messages') {
		return await countInternalUserEmailMessages({
			env: input.env,
			ownerId: input.userId,
		})
	}
	return await readEntitlementResourceUsage({
		db: input.db,
		userId: input.userId,
		resource: input.resource,
		now: input.now,
	})
}

/** Bounded retries for cold bootstrap contention (concurrent callers may both attempt initializeStorageBytes). */
const storageBytesBootstrapMaxAttempts = 2

/**
 * Atomically reserve storage bytes in the per-user UserMeter Durable Object.
 * On `needs_bootstrap`, zero-initializes the DO singleton via
 * `initializeStorageBytes` (INSERT OR IGNORE — concurrent-safe, matching the
 * daily counter cold path), then retries once. The bounded reconcile lane
 * recomputes physical D1 payload bytes and corrects drift via CAS.
 * Missing-user synthetic contexts (no `users` row) preserve current free-plan
 * allow/deny semantics without touching the DO.
 *
 * `getCurrent` is a check-only path for StorageRunner bucket totals and does
 * not reserve in UserMeter; `env` is not required on that path.
 *
 * The `env` / `USER_METER` binding is required for the DO reserve path and
 * throws immediately when absent — failing closed for real users.
 */
export async function assertWithinStorageBytesEntitlement(input: {
	db: D1Database
	userId: string
	email: string | null | undefined
	requested?: number
	getCurrent?: () => Promise<number>
	/**
	 * UserMeter binding: required for the DO reserve path (non-getCurrent).
	 * Throws immediately if absent; omit only when passing getCurrent.
	 */
	env?: UserMeterEnv
}) {
	if (input.getCurrent) {
		await assertWithinEntitlement({
			db: input.db,
			userId: input.userId,
			email: input.email,
			resource: 'storage_bytes',
			requested: input.requested,
			getCurrent: input.getCurrent,
		})
		return
	}

	// DO-authoritative reserve path: env.USER_METER is required.
	if (!input.env || !userMeterNamespace(input.env)) {
		throw new Error(
			'assertWithinStorageBytesEntitlement requires env.USER_METER for the atomic reserve path.',
		)
	}

	// Preserve the plan-cache convention: limit resolution tolerates ~60s
	// staleness while the DO counter itself is always fresh.
	const plan = await getCachedUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = resolvePlanLimit(plan, 'storage_bytes')
	const requested = Math.max(0, input.requested ?? 1)
	const updatedAt = new Date().toISOString()

	const meter = userMeterRpc({ env: input.env, userId: input.userId })

	for (let attempt = 0; attempt < storageBytesBootstrapMaxAttempts; attempt++) {
		const result = await meter.reserveStorageBytes({
			requested,
			limit,
			updatedAt,
		})

		if (result.outcome === 'needs_bootstrap') {
			if (
				!(await userAccountRowExists({ db: input.db, userId: input.userId }))
			) {
				// Synthetic context: no users row — cannot create a DO entry for a
				// non-existent account. Apply free-plan allow/deny without DO.
				const current = 0
				if (current + requested <= limit) return
				throw new EntitlementLimitError({
					resource: 'storage_bytes',
					plan,
					limit,
					current,
					upgradeHint: buildEntitlementUpgradeHint('storage_bytes'),
				})
			}
			// Real user with no DO row: zero-initialize, then retry. The
			// reconcile lane corrects the counter from physical payload bytes.
			await meter.initializeStorageBytes({
				bytes: 0,
				updatedAt,
			})
			continue
		}

		if (!result.reserved) {
			throw new EntitlementLimitError({
				resource: 'storage_bytes',
				plan,
				limit,
				current: result.bytes,
				upgradeHint: buildEntitlementUpgradeHint('storage_bytes'),
			})
		}

		return
	}

	throw new Error(
		'UserMeter storage bytes reserve still needs bootstrap after initialize.',
	)
}

export type AssertWithinEntitlementInput = {
	db: D1Database
	userId: string
	/**
	 * Account email of the acting user when available. When present, plan
	 * lookup requires the email + stable-id pair. When absent (package-job /
	 * workflow contexts with `email: ''`), {@link getCachedUserPlan}
	 * reverse-resolves by stable userId; unknown accounts still fail closed
	 * to `free`.
	 */
	email: string | null | undefined
	resource: EntitlementResource
	/** How many units the operation is about to consume. Defaults to 1. */
	requested?: number
	/**
	 * Override the built-in usage counter for this resource. Required for
	 * `concurrent_workflows` (pass RunLog reservation occupancy).
	 */
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
	// Cached plan resolution: quota limit lookup tolerates short-TTL
	// staleness; usage counters below stay fresh on every call.
	const plan = await getCachedUserPlan(input.db, {
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

export type ConsumeDailyEntitlementInput = {
	db: D1Database
	/** Must expose `USER_METER` (sole daily counter authority). */
	env: UserMeterEnv
	userId: string
	email: string | null | undefined
	resource: EntitlementResource
	now?: Date
	/**
	 * Retained for call-site stability. Daily counters no longer schedule D1
	 * mirror work; unused after mirror retirement.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Atomically consume one daily entitlement unit via UserMeter, throwing
 * EntitlementLimitError when the plan limit would be exceeded. Cold keys
 * initialize at zero (concurrent-safe); warm path awaits only the DO RPC.
 * Never touches the retired D1 daily counter table.
 */
export async function consumeDailyEntitlement(
	input: ConsumeDailyEntitlementInput,
): Promise<void> {
	void input.waitUntil
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	// Cached plan resolution: this runs on every execute call and every
	// sandbox outbound fetch; the UserMeter consume below is the only
	// counter state that must be fresh.
	const plan = await getCachedUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limit = resolvePlanLimit(plan, resource)
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await meter.consume({
		resource,
		day,
		limit,
		updatedAt,
	})
	if (result.outcome === 'needs_bootstrap') {
		await ensureUserMeterCounterInitializedAtZero({
			env: input.env,
			userId: input.userId,
			resource,
			day,
			updatedAt,
		})
		result = await meter.consume({
			resource,
			day,
			limit,
			updatedAt,
		})
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter consume still needs bootstrap after initialize.',
			)
		}
	}
	if (!result.consumed) {
		throw new EntitlementLimitError({
			resource,
			plan,
			limit,
			current: result.count,
			upgradeHint: buildEntitlementUpgradeHint(resource),
		})
	}
}

export type RefundDailyEntitlementInput = {
	db: D1Database
	env: UserMeterEnv
	userId: string
	resource: EntitlementResource
	now?: Date
	/**
	 * Retained for call-site stability. Daily counters no longer schedule D1
	 * mirror work; unused after mirror retirement.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Atomically refund one previously consumed daily entitlement unit in
 * UserMeter (floors at zero). Pass the same `now` (day key) as the matching
 * consume. Never touches the retired D1 daily counter table.
 */
export async function refundDailyEntitlement(
	input: RefundDailyEntitlementInput,
): Promise<void> {
	void input.db
	void input.waitUntil
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	await meter.refund({
		resource,
		day,
		updatedAt,
	})
}
