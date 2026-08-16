import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { replaceRepoSessionDueOwner } from '#worker/repo/repo-session-due-owners.ts'
import { repoSessionIndexRpc } from '#worker/repo/repo-session-index-client.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	maybeRefreshStorageBucketEstimate,
	recordStorageBucketEstimate,
	registerMissingRepoSessionStorageBuckets,
	registerStorageBucket,
} from './service.ts'
import { ensureUserStorageBucketsTestSchema } from './test-schema.ts'

function catalogSessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		...overrides,
	}
}

test('registerStorageBucket upserts and list helpers scope correctly on real D1', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const userA = `usb-a-${crypto.randomUUID()}`
	const userB = `usb-b-${crypto.randomUUID()}`
	const bucketA = `exec:${crypto.randomUUID()}`
	const bucketB = `job:${crypto.randomUUID()}`
	const sessionBucket = `repo-session:${crypto.randomUUID()}`
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}

	registerStorageBucket({
		env,
		userId: userA,
		storageId: bucketA,
		kind: 'execute',
		waitUntil,
	})
	registerStorageBucket({
		env,
		userId: userB,
		storageId: bucketB,
		kind: 'job',
		waitUntil,
	})
	registerStorageBucket({
		env,
		userId: userA,
		storageId: sessionBucket,
		kind: 'repo_session',
		waitUntil,
	})
	await Promise.all(pending)

	await expect(
		listUserStorageBucketIds({ env, userId: userA }),
	).resolves.toEqual([bucketA])
	await expect(
		listUserStorageBucketEstimates({ env, userId: userA }),
	).resolves.toEqual(
		[
			{ storageId: bucketA, kind: 'execute', estimatedBytes: null },
			{
				storageId: sessionBucket,
				kind: 'repo_session',
				estimatedBytes: null,
			},
		].sort((left, right) => left.storageId.localeCompare(right.storageId)),
	)
	await expect(
		listUserStorageBucketIds({ env, userId: userB }),
	).resolves.toEqual([bucketB])

	const platform = await listPlatformStorageBuckets({ db: env.APP_DB })
	expect(platform).toEqual(
		expect.arrayContaining([
			{ userId: userA, storageId: bucketA },
			{ userId: userB, storageId: bucketB },
		]),
	)
	expect(platform).not.toContainEqual({
		userId: userA,
		storageId: sessionBucket,
	})
})

test('missing repo-session inventory reconciliation registers only active sessions', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	const userId = `usb-reconcile-${crypto.randomUUID()}`
	const activeSession = `rs-active-${crypto.randomUUID()}`
	const discardedSession = `rs-discarded-${crypto.randomUUID()}`
	const registeredSession = `rs-registered-${crypto.randomUUID()}`
	const index = repoSessionIndexRpc({ env, userId })
	await index.insertSession({
		ownerId: userId,
		row: catalogSessionRow({ id: activeSession, user_id: userId }),
	})
	await index.insertSession({
		ownerId: userId,
		row: catalogSessionRow({
			id: discardedSession,
			user_id: userId,
			status: 'discarded',
		}),
	})
	await index.insertSession({
		ownerId: userId,
		row: catalogSessionRow({ id: registeredSession, user_id: userId }),
	})
	await replaceRepoSessionDueOwner({
		db: env.APP_DB,
		userId,
		dueAt: '2099-01-01T00:00:00.000Z',
	})
	// Pre-existing inventory row: reconciliation must not duplicate or touch it.
	await env.APP_DB.prepare(
		`INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at, estimated_bytes
		) VALUES (?, ?, 'repo_session', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 42)`,
	)
		.bind(userId, `repo-session:${registeredSession}`)
		.run()

	const inserted = await registerMissingRepoSessionStorageBuckets({
		db: env.APP_DB,
		env,
	})
	expect(inserted).toBeGreaterThanOrEqual(1)

	const estimates = await listUserStorageBucketEstimates({ env, userId })
	const ids = estimates.map((row) => row.storageId)
	expect(ids).toContain(`repo-session:${activeSession}`)
	expect(ids).not.toContain(`repo-session:${discardedSession}`)
	expect(
		estimates.find((row) => row.storageId === `repo-session:${activeSession}`)
			?.estimatedBytes,
	).toBeNull()
	expect(
		estimates.find(
			(row) => row.storageId === `repo-session:${registeredSession}`,
		)?.estimatedBytes,
	).toBe(42)

	await registerMissingRepoSessionStorageBuckets({ db: env.APP_DB, env })
	const after = await listUserStorageBucketEstimates({ env, userId })
	expect(after.length).toBe(estimates.length)
})

test('estimate persistence is UPDATE-only, listable, and throttled per isolate', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const userId = `usb-estimate-${crypto.randomUUID()}`
	const registered = `exec:${crypto.randomUUID()}`
	const unregistered = `exec:${crypto.randomUUID()}`
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}

	registerStorageBucket({
		env,
		userId,
		storageId: registered,
		kind: 'execute',
		waitUntil,
	})
	await Promise.all(pending)
	await expect(
		listUserStorageBucketEstimates({ env, userId }),
	).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: null },
	])

	recordStorageBucketEstimate({
		env,
		userId,
		storageId: registered,
		estimatedBytes: 4096,
		waitUntil,
	})
	// UPDATE-only: recording an estimate for a bucket without an ownership
	// row must not create one (this is what keeps the persist safe on
	// clearStorage paths racing account or bucket deletion).
	recordStorageBucketEstimate({
		env,
		userId,
		storageId: unregistered,
		estimatedBytes: 123,
		waitUntil,
	})
	await Promise.all(pending)
	await expect(
		listUserStorageBucketEstimates({ env, userId }),
	).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: 4096 },
	])

	let reads = 0
	const readEstimatedBytes = async () => {
		reads += 1
		return 8192
	}
	maybeRefreshStorageBucketEstimate({
		env,
		userId,
		storageId: registered,
		readEstimatedBytes,
		waitUntil,
	})
	maybeRefreshStorageBucketEstimate({
		env,
		userId,
		storageId: registered,
		readEstimatedBytes,
		waitUntil,
	})
	await Promise.all(pending)
	expect(reads).toBe(1)
	await expect(
		listUserStorageBucketEstimates({ env, userId }),
	).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: 8192 },
	])
})

test('a failed estimate refresh warns and clears the throttle for a retry', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	const userId = `usb-estimate-retry-${crypto.randomUUID()}`
	const storageId = `exec:${crypto.randomUUID()}`
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}

	registerStorageBucket({
		env,
		userId,
		storageId,
		kind: 'execute',
		waitUntil,
	})
	await Promise.all(pending)

	let attempts = 0
	const readEstimatedBytes = async () => {
		attempts += 1
		if (attempts === 1) {
			throw new Error('simulated estimate read failure')
		}
		return 2048
	}
	maybeRefreshStorageBucketEstimate({
		env,
		userId,
		storageId,
		readEstimatedBytes,
		waitUntil,
	})
	await Promise.all(pending)
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-estimate-refresh-failed',
		expect.any(Error),
	)

	// The failed attempt must not consume the throttle window.
	maybeRefreshStorageBucketEstimate({
		env,
		userId,
		storageId,
		readEstimatedBytes,
		waitUntil,
	})
	await Promise.all(pending)
	expect(attempts).toBe(2)
	await expect(
		listUserStorageBucketEstimates({ env, userId }),
	).resolves.toEqual([{ storageId, kind: 'execute', estimatedBytes: 2048 }])
})

test('registerStorageBucket never throws when the table is missing', async () => {
	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	const missingTableDb = {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							throw new Error('no such table: user_storage_buckets')
						},
					}
				},
			}
		},
	} as unknown as D1Database

	expect(() =>
		registerStorageBucket({
			env: { APP_DB: missingTableDb } as Env,
			userId: 'user-missing-table',
			storageId: 'bucket-missing-table',
		}),
	).not.toThrow()
	await flushStorageBucketRegistrationsForTests()
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-register-failed',
		expect.any(Error),
	)
})
