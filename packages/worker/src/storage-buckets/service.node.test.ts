import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { replaceRepoSessionDueOwner } from '#worker/repo/repo-session-due-owners.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { readRepoSessionStorageBucketCursor } from './repo-session-storage-bucket-cursor.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	registerMissingRepoSessionStorageBuckets,
	registerStorageBucket,
	repoSessionStorageBucketId,
	storageBucketKindFromStorageId,
} from './service.ts'

function createCountingDb(input?: { failRun?: boolean }) {
	let insertCount = 0
	const rows = new Map<string, { userId: string; storageId: string }>()

	function listRows<T>(userFilter: string | null) {
		const results = [...rows.values()]
			.filter((row) => (userFilter ? row.userId === userFilter : true))
			.sort((left, right) =>
				`${left.userId}\0${left.storageId}`.localeCompare(
					`${right.userId}\0${right.storageId}`,
				),
			)
			.map((row) =>
				userFilter
					? ({ storageId: row.storageId } as T)
					: ({
							userId: row.userId,
							storageId: row.storageId,
						} as T),
			)
		return { results, meta: { changes: 0 } }
	}

	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (sql.includes('INSERT INTO user_storage_buckets')) {
								insertCount += 1
								if (input?.failRun) {
									throw new Error('simulated upsert failure')
								}
								const userId = String(params[0])
								const storageId = String(params[1])
								rows.set(`${userId}\u0000${storageId}`, { userId, storageId })
							}
							return { meta: { changes: 1 } }
						},
						async all<T>() {
							if (!sql.includes('FROM user_storage_buckets')) {
								return { results: [] as Array<T>, meta: { changes: 0 } }
							}
							const userFilter =
								sql.includes('WHERE user_id = ?') && params[0] != null
									? String(params[0])
									: null
							return listRows<T>(userFilter)
						},
					}
				},
				async all<T>() {
					if (!sql.includes('FROM user_storage_buckets')) {
						return { results: [] as Array<T>, meta: { changes: 0 } }
					}
					return listRows<T>(null)
				},
			}
		},
	} as unknown as D1Database
	return {
		db,
		env: { APP_DB: db } as Env,
		get insertCount() {
			return insertCount
		},
		rows,
	}
}

test('storage bucket registration soft-fails, dedupes, and lists by user', async () => {
	expect(storageBucketKindFromStorageId('job:abc')).toBe('job')
	expect(storageBucketKindFromStorageId('exec:abc')).toBe('execute')
	expect(storageBucketKindFromStorageId('package:abc')).toBe('package')
	expect(storageBucketKindFromStorageId('service:abc')).toBe('service')
	expect(storageBucketKindFromStorageId('adhoc-bucket')).toBe('unknown')

	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	expect(() =>
		registerStorageBucket({
			env: {} as Env,
			userId: 'user-a',
			storageId: 'bucket-a',
		}),
	).not.toThrow()
	const failing = createCountingDb({ failRun: true })
	expect(() =>
		registerStorageBucket({
			env: failing.env,
			userId: 'user-a',
			storageId: 'bucket-a',
			kind: 'execute',
		}),
	).not.toThrow()
	await flushStorageBucketRegistrationsForTests()
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-register-failed',
		expect.any(Error),
	)

	clearStorageBucketRegistrationDedupeForTests()
	const counting = createCountingDb()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}
	for (let index = 0; index < 5; index += 1) {
		registerStorageBucket({
			env: counting.env,
			userId: 'user-a',
			storageId: 'exec:same',
			kind: 'execute',
			waitUntil,
		})
	}
	registerStorageBucket({
		env: counting.env,
		userId: 'user-a',
		storageId: 'bucket-a',
		waitUntil,
	})
	registerStorageBucket({
		env: counting.env,
		userId: 'user-b',
		storageId: 'bucket-b',
		waitUntil,
	})
	await Promise.all(pending)

	expect(counting.insertCount).toBe(3)
	await expect(
		listUserStorageBucketIds({ env: counting.env, userId: 'user-a' }),
	).resolves.toEqual(['bucket-a', 'exec:same'])
	await expect(
		listUserStorageBucketIds({ env: counting.env, userId: 'user-b' }),
	).resolves.toEqual(['bucket-b'])
	await expect(
		listPlatformStorageBuckets({ db: counting.db }),
	).resolves.toEqual([
		{ userId: 'user-a', storageId: 'bucket-a' },
		{ userId: 'user-a', storageId: 'exec:same' },
		{ userId: 'user-b', storageId: 'bucket-b' },
	])
})

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

test('index-backed storage-bucket reconcile pages owners with a persisted cursor', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	const now = new Date('2026-06-24T20:00:00.000Z')
	const users = ['user-a', 'user-b', 'user-c'] as const
	for (const userId of users) {
		await replaceRepoSessionDueOwner({
			db,
			userId,
			dueAt: '2099-01-01T00:00:00.000Z',
			now,
		})
		await indexEnv.REPO_SESSION_INDEX.get(
			indexEnv.REPO_SESSION_INDEX.idFromName(userId),
		).insertSession({
			ownerId: userId,
			row: catalogSessionRow({
				id: `${userId}-active`,
				user_id: userId,
			}),
		})
	}
	await indexEnv.REPO_SESSION_INDEX.get(
		indexEnv.REPO_SESSION_INDEX.idFromName('user-a'),
	).insertSession({
		ownerId: 'user-a',
		row: catalogSessionRow({
			id: 'user-a-discarded',
			user_id: 'user-a',
			status: 'discarded',
		}),
	})

	const first = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(first).toBe(2)
	// Insert limit filled on user-b, so the cursor stays on the last fully
	// processed owner and the next tick retries user-b instead of skipping
	// any remaining sessions.
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-a')
	await expect(
		listUserStorageBucketEstimates({
			env: { APP_DB: db } as Env,
			userId: 'user-a',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-a-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])
	await expect(
		listUserStorageBucketEstimates({
			env: { APP_DB: db } as Env,
			userId: 'user-b',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-b-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])
	await expect(
		listUserStorageBucketEstimates({
			env: { APP_DB: db } as Env,
			userId: 'user-c',
		}),
	).resolves.toEqual([])

	const second = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(second).toBe(1)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-c')
	await expect(
		listUserStorageBucketEstimates({
			env: { APP_DB: db } as Env,
			userId: 'user-c',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-c-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])

	const wrapped = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(wrapped).toBe(0)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('')

	const steady = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(steady).toBe(0)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-b')
})
