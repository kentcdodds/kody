import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { backfillStorageBucketEstimates } from './estimate-backfill.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
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
		const sessionId = crypto.randomUUID()
		const sessionBucket = `repo-session:${sessionId}`
		// Warm the Durable Object namespace with an unbounded RPC so the
		// backfill's 2s-bounded estimate reads measure steady-state behavior.
		await storageRunnerRpc({
			env,
			userId,
			storageId: bucketA,
		}).getEstimatedBytes()
		const sessionEstimate = (
			await repoSessionRpc(env, sessionId).getEstimatedBytes()
		).estimatedBytes
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
			storageId: sessionBucket,
			kind: 'repo_session',
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
			[bucketA, bucketB, sessionBucket]
				.sort()
				.map((storageId) => ({
					storageId,
					kind: storageId === sessionBucket ? 'repo_session' : undefined,
					estimatedBytes: null,
				}))
				.map((row) => ({
					...row,
					kind:
						row.kind ??
						(row.storageId.startsWith('exec:') ? 'execute' : 'package'),
				})),
		)

		// The bound is respected: batchSize 1 measures exactly one bucket.
		await expect(
			backfillStorageBucketEstimates({ env, batchSize: 1 }),
		).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })

		// The next sweep finishes the rest; both buckets end up measured at
		// the never-written DO baseline.
		await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
			scanned: 2,
			updated: 2,
			failed: 0,
		})
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual(
			[bucketA, bucketB, sessionBucket].sort().map((storageId) => ({
				storageId,
				kind:
					storageId === sessionBucket
						? 'repo_session'
						: storageId.startsWith('exec:')
							? 'execute'
							: 'package',
				estimatedBytes:
					storageId === sessionBucket
						? sessionEstimate
						: emptyStorageRunnerEstimatedBytes,
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

test(
	'backfill clears leftover service StorageRunner objects before dropping inventory',
	{ timeout: testTimeout },
	async () => {
		await ensureUserStorageBucketsTestSchema(env.APP_DB)
		clearStorageBucketRegistrationDedupeForTests()
		const userId = `usb-service-purge-${crypto.randomUUID()}`
		const liveBucket = `package:${crypto.randomUUID()}`
		const leftoverBucket = `service:${crypto.randomUUID()}`
		const now = new Date().toISOString()
		await env.APP_DB.prepare(
			`INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at,
				estimated_bytes
			) VALUES (?, ?, 'service', ?, ?, NULL), (?, ?, 'package', ?, ?, ?)`,
		)
			.bind(
				userId,
				leftoverBucket,
				now,
				now,
				userId,
				liveBucket,
				now,
				now,
				emptyStorageRunnerEstimatedBytes,
			)
			.run()
		await storageRunnerRpc({
			env,
			userId,
			storageId: leftoverBucket,
		}).setValue({ key: 'leftover', value: { kept: true } })
		await flushStorageBucketRegistrationsForTests()
		await expect(
			storageRunnerRpc({
				env,
				userId,
				storageId: leftoverBucket,
			}).getValue({ key: 'leftover' }),
		).resolves.toEqual({
			key: 'leftover',
			value: { kept: true },
		})
		await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual(
			[liveBucket, leftoverBucket].sort(),
		)

		await backfillStorageBucketEstimates({ env })
		await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
			liveBucket,
		])
		await expect(
			storageRunnerRpc({
				env,
				userId,
				storageId: leftoverBucket,
			}).getValue({ key: 'leftover' }),
		).resolves.toEqual({ key: 'leftover', value: null })
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual([
			{
				storageId: liveBucket,
				kind: 'package',
				estimatedBytes: emptyStorageRunnerEstimatedBytes,
			},
		])
	},
)
