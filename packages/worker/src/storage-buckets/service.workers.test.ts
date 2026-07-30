import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	maybeRefreshStorageBucketEstimate,
	recordStorageBucketEstimate,
	registerStorageBucket,
} from './service.ts'
import { ensureUserStorageBucketsTestSchema } from './test-schema.ts'

test('registerStorageBucket upserts and list helpers scope correctly on real D1', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const userA = `usb-a-${crypto.randomUUID()}`
	const userB = `usb-b-${crypto.randomUUID()}`
	const bucketA = `exec:${crypto.randomUUID()}`
	const bucketB = `job:${crypto.randomUUID()}`
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
	await Promise.all(pending)

	await expect(
		listUserStorageBucketIds({ env, userId: userA }),
	).resolves.toEqual([bucketA])
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
	).resolves.toEqual([{ storageId: registered, estimatedBytes: null }])

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
	).resolves.toEqual([{ storageId: registered, estimatedBytes: 4096 }])

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
	).resolves.toEqual([{ storageId: registered, estimatedBytes: 8192 }])
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
	).resolves.toEqual([{ storageId, estimatedBytes: 2048 }])
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
