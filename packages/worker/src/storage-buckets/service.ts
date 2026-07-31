/**
 * Authoritative per-user durable storage bucket ownership.
 *
 * Cloudflare cannot enumerate Durable Objects by name, so every consumer that
 * needs "which StorageRunner buckets does this user own?" must read D1. That
 * inventory is state (`user_storage_buckets`), not run history.
 *
 * Helper contract (same spirit as `recordUsage`):
 * - `registerStorageBucket` is synchronous, never throws, and never rejects
 *   into the caller. Missing binding / userId / storageId is a silent no-op.
 * - Failures during the async upsert are logged with
 *   `console.warn('storage-bucket-register-failed', error)`.
 * - Prefer `waitUntil` when an ExecutionContext is available; otherwise the
 *   upsert is fire-and-forget (`void`).
 * - Register only on write-ish StorageRunner access. In-isolate dedupe keeps
 *   hot buckets from becoming per-event shared D1 writes.
 *
 * The inventory rows also carry the latest per-bucket byte estimate
 * (`estimated_bytes`, migration 0118) so storage-byte entitlement checks can
 * read most bucket sizes from D1 instead of fanning `getEstimatedBytes` RPCs
 * across every StorageRunner Durable Object. Estimate writes follow the same
 * never-throw fire-and-forget contract and are UPDATE-only: they can never
 * recreate an inventory row that account, package, or job deletion removed.
 */

export type StorageBucketKind =
	| 'job'
	| 'package'
	| 'service'
	| 'execute'
	| 'unknown'

const registerUpsertStatement = `
INSERT INTO user_storage_buckets (
	user_id, storage_id, kind, created_at, last_seen_at
) VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT (user_id, storage_id) DO UPDATE SET
	last_seen_at = excluded.last_seen_at
`.trim()

/**
 * Estimate persistence is UPDATE-only on purpose: it can never recreate an
 * ownership row after account deletion or package/job cleanup removed it, so
 * it is safe to run on any StorageRunner path, including clearStorage.
 */
const estimateUpdateStatement = `
UPDATE user_storage_buckets
SET estimated_bytes = ?3, estimated_bytes_updated_at = ?4
WHERE user_id = ?1 AND storage_id = ?2
`.trim()

/**
 * Minimum spacing between opportunistic post-write estimate refreshes for one
 * bucket in one isolate. Stored estimates are freshness hints for the
 * storage-byte entitlement (the bucket being written is probed live), so a
 * bounded lag is fine and keeps hot write loops from turning into per-call
 * D1 writes and DO estimate RPCs.
 */
export const storageBucketEstimateRefreshMinIntervalMs = 15_000

/** Bound in-isolate dedupe so a long-lived isolate cannot grow without limit. */
const maxRegisteredBucketKeys = 4_096
const registeredBucketKeys = new Set<string>()
const estimateRefreshAttemptsAtMs = new Map<string, number>()
const pendingRegistrations = new Set<Promise<unknown>>()

function registrationDedupeKey(userId: string, storageId: string) {
	return `${userId}\u0000${storageId}`
}

function rememberRegistrationKey(key: string) {
	if (registeredBucketKeys.has(key)) return false
	if (registeredBucketKeys.size >= maxRegisteredBucketKeys) {
		registeredBucketKeys.clear()
	}
	registeredBucketKeys.add(key)
	return true
}

function scheduleRegistration(
	work: Promise<unknown>,
	waitUntil?: (promise: Promise<unknown>) => void,
) {
	const tracked = work.finally(() => {
		pendingRegistrations.delete(tracked)
	})
	pendingRegistrations.add(tracked)
	if (waitUntil) {
		waitUntil(tracked)
		return
	}
	void tracked
}

/** Synchronous, never throws, fire-and-forget. No-op without a binding/userId/storageId. */
export function registerStorageBucket(input: {
	env: Env
	userId?: string | null
	storageId?: string | null
	kind?: StorageBucketKind
	waitUntil?: (promise: Promise<unknown>) => void
}): void {
	try {
		const userId = input.userId?.trim()
		const storageId = input.storageId?.trim()
		if (!userId || !storageId) return
		const db = input.env.APP_DB
		if (!db) return
		const key = registrationDedupeKey(userId, storageId)
		if (!rememberRegistrationKey(key)) return
		const kind = input.kind ?? 'unknown'
		const seenAt = new Date().toISOString()
		scheduleRegistration(
			db
				.prepare(registerUpsertStatement)
				.bind(userId, storageId, kind, seenAt)
				.run()
				.then(() => undefined)
				.catch((error: unknown) => {
					registeredBucketKeys.delete(key)
					console.warn('storage-bucket-register-failed', error)
				}),
			input.waitUntil,
		)
	} catch (error) {
		console.warn('storage-bucket-register-failed', error)
	}
}

function normalizeEstimatedBytes(estimatedBytes: number) {
	if (!Number.isFinite(estimatedBytes)) return null
	return Math.max(0, Math.round(estimatedBytes))
}

/**
 * Awaited UPDATE-only estimate persist. Returns whether an inventory row was
 * updated: false either when the row does not exist (registration owns row
 * creation) or when `estimatedBytes` is not a finite number (nothing is
 * written). Callers that need to distinguish the two must validate the
 * estimate before calling.
 */
export async function updateStorageBucketEstimate(input: {
	db: D1Database
	userId: string
	storageId: string
	estimatedBytes: number
	updatedAt?: Date
}): Promise<boolean> {
	const estimatedBytes = normalizeEstimatedBytes(input.estimatedBytes)
	if (estimatedBytes === null) return false
	const result = await input.db
		.prepare(estimateUpdateStatement)
		.bind(
			input.userId,
			input.storageId,
			estimatedBytes,
			(input.updatedAt ?? new Date()).toISOString(),
		)
		.run()
	return (result.meta?.changes ?? 0) > 0
}

/**
 * Oldest-estimate-first page of inventory rows that have never been measured.
 * Used by the cron backfill lane so freshly deployed inventories converge to
 * "every bucket has a stored estimate" without waiting for each bucket's
 * next write.
 */
export async function listStorageBucketsMissingEstimates(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ userId: string; storageId: string }>> {
	const result = await input.db
		.prepare(
			`SELECT user_id AS userId, storage_id AS storageId
			FROM user_storage_buckets
			WHERE estimated_bytes IS NULL
			ORDER BY last_seen_at DESC, user_id ASC, storage_id ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<{ userId: string; storageId: string }>()
	return result.results ?? []
}

/**
 * Persist one bucket's byte estimate onto its existing inventory row.
 * Synchronous, never throws, fire-and-forget, and UPDATE-only (a bucket
 * without an ownership row is simply not recorded; registration owns row
 * creation). Failures are logged with
 * `console.warn('storage-bucket-estimate-record-failed', error)`.
 */
export function recordStorageBucketEstimate(input: {
	env: Env
	userId?: string | null
	storageId?: string | null
	estimatedBytes: number
	waitUntil?: (promise: Promise<unknown>) => void
}): void {
	try {
		const userId = input.userId?.trim()
		const storageId = input.storageId?.trim()
		if (!userId || !storageId) return
		const db = input.env.APP_DB
		if (!db) return
		scheduleRegistration(
			updateStorageBucketEstimate({
				db,
				userId,
				storageId,
				estimatedBytes: input.estimatedBytes,
			})
				.then(() => undefined)
				.catch((error: unknown) => {
					console.warn('storage-bucket-estimate-record-failed', error)
				}),
			input.waitUntil,
		)
	} catch (error) {
		console.warn('storage-bucket-estimate-record-failed', error)
	}
}

/**
 * Opportunistically refresh one bucket's stored estimate after a mutating
 * StorageRunner operation. Synchronous, never throws, fire-and-forget, and
 * throttled per (userId, storageId) per isolate so hot write loops do not
 * issue an estimate RPC and D1 write per call. `readEstimatedBytes` is
 * expected to be a bounded read (the storage-runner caller wraps it in the
 * estimate read timeout).
 */
export function maybeRefreshStorageBucketEstimate(input: {
	env: Env
	userId?: string | null
	storageId?: string | null
	readEstimatedBytes: () => Promise<number>
	waitUntil?: (promise: Promise<unknown>) => void
}): void {
	try {
		const userId = input.userId?.trim()
		const storageId = input.storageId?.trim()
		if (!userId || !storageId) return
		const db = input.env.APP_DB
		if (!db) return
		const key = registrationDedupeKey(userId, storageId)
		const now = Date.now()
		const lastAttemptAt = estimateRefreshAttemptsAtMs.get(key)
		if (
			lastAttemptAt !== undefined &&
			now - lastAttemptAt < storageBucketEstimateRefreshMinIntervalMs
		) {
			return
		}
		if (estimateRefreshAttemptsAtMs.size >= maxRegisteredBucketKeys) {
			estimateRefreshAttemptsAtMs.clear()
		}
		estimateRefreshAttemptsAtMs.set(key, now)
		scheduleRegistration(
			input
				.readEstimatedBytes()
				.then(async (estimatedBytes) => {
					await updateStorageBucketEstimate({
						db,
						userId,
						storageId,
						estimatedBytes,
					})
				})
				.catch((error: unknown) => {
					// Allow an immediate retry after a failed refresh attempt.
					if (estimateRefreshAttemptsAtMs.get(key) === now) {
						estimateRefreshAttemptsAtMs.delete(key)
					}
					console.warn('storage-bucket-estimate-refresh-failed', error)
				}),
			input.waitUntil,
		)
	} catch (error) {
		console.warn('storage-bucket-estimate-refresh-failed', error)
	}
}

export async function listUserStorageBucketIds(input: {
	env: Env
	userId: string
}): Promise<Array<string>> {
	const result = await input.env.APP_DB.prepare(
		`SELECT storage_id AS storageId
		FROM user_storage_buckets
		WHERE user_id = ?
		ORDER BY storage_id ASC`,
	)
		.bind(input.userId)
		.all<{ storageId: string }>()
	return (result.results ?? []).map((row) => row.storageId)
}

/**
 * Bucket inventory with stored byte estimates for the storage-byte
 * entitlement baseline. `estimatedBytes: null` means the bucket has never
 * been measured (or a garbage value was stored) and must be probed live.
 */
export async function listUserStorageBucketEstimates(input: {
	env: Env
	userId: string
}): Promise<Array<{ storageId: string; estimatedBytes: number | null }>> {
	const result = await input.env.APP_DB.prepare(
		`SELECT storage_id AS storageId, estimated_bytes AS estimatedBytes
		FROM user_storage_buckets
		WHERE user_id = ?
		ORDER BY storage_id ASC`,
	)
		.bind(input.userId)
		.all<{ storageId: string; estimatedBytes: number | null }>()
	return (result.results ?? []).map((row) => ({
		storageId: row.storageId,
		estimatedBytes:
			typeof row.estimatedBytes === 'number' && row.estimatedBytes >= 0
				? row.estimatedBytes
				: null,
	}))
}

export async function listPlatformStorageBuckets(input: {
	db: D1Database
}): Promise<Array<{ userId: string; storageId: string }>> {
	const result = await input.db
		.prepare(
			`SELECT user_id AS userId, storage_id AS storageId
			FROM user_storage_buckets
			ORDER BY user_id ASC, storage_id ASC`,
		)
		.all<{ userId: string; storageId: string }>()
	return result.results ?? []
}

export function storageBucketKindFromStorageId(
	storageId: string,
): StorageBucketKind {
	if (storageId.startsWith('job:')) return 'job'
	if (storageId.startsWith('exec:')) return 'execute'
	if (storageId.startsWith('package:')) return 'package'
	if (storageId.startsWith('service:')) return 'service'
	return 'unknown'
}

/**
 * Test helper: await fire-and-forget registration and estimate writes
 * scheduled in this isolate.
 */
export async function flushStorageBucketRegistrationsForTests(): Promise<void> {
	await Promise.all([...pendingRegistrations])
}

/** Test helper: clear the in-isolate registration dedupe and refresh throttle. */
export function clearStorageBucketRegistrationDedupeForTests(): void {
	registeredBucketKeys.clear()
	estimateRefreshAttemptsAtMs.clear()
}
