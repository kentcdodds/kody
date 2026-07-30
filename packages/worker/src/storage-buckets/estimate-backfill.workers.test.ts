import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { backfillStorageBucketEstimates } from './estimate-backfill.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	listUserStorageBucketEstimates,
	registerStorageBucket,
} from './service.ts'
import { ensureUserStorageBucketsTestSchema } from './test-schema.ts'

// The first Durable Object RPC in a fresh test isolate lazily loads the whole
// worker main module (several seconds), which would otherwise trip the
// backfill's bounded per-read estimate timeout and the default test timeout.
const testTimeout = 30_000

test(
	'backfill seeds stored estimates for unmeasured buckets in bounded batches',
	{ timeout: testTimeout },
	async () => {
		await ensureUserStorageBucketsTestSchema(env.APP_DB)
		clearStorageBucketRegistrationDedupeForTests()
		const userId = `usb-backfill-${crypto.randomUUID()}`
		const bucketA = `exec:${crypto.randomUUID()}`
		const bucketB = `package:${crypto.randomUUID()}`
		// Warm the Durable Object namespace with an unbounded RPC so the
		// backfill's 2s-bounded estimate reads measure steady-state behavior.
		await storageRunnerRpc({
			env,
			userId,
			storageId: bucketA,
		}).getEstimatedBytes()
		const pending: Array<Promise<unknown>> = []
		const waitUntil = (promise: Promise<unknown>) => {
			pending.push(promise)
		}
		registerStorageBucket({
			env,
			userId,
			storageId: bucketA,
			kind: 'execute',
			waitUntil,
		})
		registerStorageBucket({
			env,
			userId,
			storageId: bucketB,
			kind: 'package',
			waitUntil,
		})
		await Promise.all(pending)

		// Registration alone leaves estimates NULL (unmeasured).
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual(
			[bucketA, bucketB]
				.sort()
				.map((storageId) => ({ storageId, estimatedBytes: null })),
		)

		// The bound is respected: batchSize 1 measures exactly one bucket.
		await expect(
			backfillStorageBucketEstimates({ env, batchSize: 1 }),
		).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })

		// The next sweep finishes the rest; both buckets end up measured at
		// the never-written DO baseline.
		await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
			scanned: 1,
			updated: 1,
			failed: 0,
		})
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual(
			[bucketA, bucketB].sort().map((storageId) => ({
				storageId,
				estimatedBytes: emptyStorageRunnerEstimatedBytes,
			})),
		)

		// Converged inventories make the lane a cheap no-op.
		await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
			scanned: 0,
			updated: 0,
			failed: 0,
		})
	},
)
