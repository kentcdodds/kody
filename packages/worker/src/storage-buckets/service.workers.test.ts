import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketIds,
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
