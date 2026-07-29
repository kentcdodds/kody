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
 */

export type StorageBucketKind =
	| 'job'
	| 'app'
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

/** Bound in-isolate dedupe so a long-lived isolate cannot grow without limit. */
const maxRegisteredBucketKeys = 4_096
const registeredBucketKeys = new Set<string>()
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

/** Test helper: await fire-and-forget registration upserts scheduled in this isolate. */
export async function flushStorageBucketRegistrationsForTests(): Promise<void> {
	await Promise.all([...pendingRegistrations])
}

/** Test helper: clear the in-isolate registration dedupe set. */
export function clearStorageBucketRegistrationDedupeForTests(): void {
	registeredBucketKeys.clear()
}
