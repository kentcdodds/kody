import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketIds,
	registerStorageBucket,
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

test('storageBucketKindFromStorageId only trusts unambiguous prefixes', () => {
	expect(storageBucketKindFromStorageId('job:abc')).toBe('job')
	expect(storageBucketKindFromStorageId('exec:abc')).toBe('execute')
	expect(storageBucketKindFromStorageId('package:abc')).toBe('unknown')
	expect(storageBucketKindFromStorageId('service:pkg:svc')).toBe('unknown')
	expect(storageBucketKindFromStorageId('adhoc-bucket')).toBe('unknown')
})

test('registerStorageBucket never throws when binding or table writes are missing', async () => {
	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()

	expect(() =>
		registerStorageBucket({
			env: {} as Env,
			userId: 'user-a',
			storageId: 'bucket-a',
		}),
	).not.toThrow()

	expect(() =>
		registerStorageBucket({
			env: { APP_DB: undefined } as unknown as Env,
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
})

test('registerStorageBucket dedupes to one D1 write per bucket in an isolate', async () => {
	clearStorageBucketRegistrationDedupeForTests()
	const counting = createCountingDb()
	const pending: Array<Promise<unknown>> = []
	for (let index = 0; index < 5; index += 1) {
		registerStorageBucket({
			env: counting.env,
			userId: 'user-a',
			storageId: 'exec:same',
			kind: 'execute',
			waitUntil: (promise) => {
				pending.push(promise)
			},
		})
	}
	await Promise.all(pending)
	expect(counting.insertCount).toBe(1)
})

test('listUserStorageBucketIds returns only the calling user buckets', async () => {
	clearStorageBucketRegistrationDedupeForTests()
	const counting = createCountingDb()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
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

	await expect(
		listUserStorageBucketIds({ env: counting.env, userId: 'user-a' }),
	).resolves.toEqual(['bucket-a'])
	await expect(
		listUserStorageBucketIds({ env: counting.env, userId: 'user-b' }),
	).resolves.toEqual(['bucket-b'])
})

test('listPlatformStorageBuckets returns every user bucket', async () => {
	clearStorageBucketRegistrationDedupeForTests()
	const counting = createCountingDb()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
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

	await expect(
		listPlatformStorageBuckets({ db: counting.db }),
	).resolves.toEqual([
		{ userId: 'user-a', storageId: 'bucket-a' },
		{ userId: 'user-b', storageId: 'bucket-b' },
	])
})
