import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { runBackupRuntime } from './backup-runtime.ts'
import { DEFAULT_BACKUP_MAX_SOURCE_BYTES } from './d1-export-api.ts'
import { readManifest } from './immutable-storage.ts'
import {
	BackupError,
	backupPayload,
	objectKeyForBookmark,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	CachedUploadStep,
	DATABASE_ID,
	MemoryBucket,
	RetryAfterCommitStep,
	environment,
	exportEnvelope,
	identityEnvelope,
} from './backup-control-plane-test-support.ts'

test('workflow retry reuses an upload committed before step persistence and writes the absent manifest', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryAfterCommitStep()
	const apiCalls: string[] = []
	let downloadCalls = 0
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		{
			api: {
				fetcher: async (input) => {
					const url = String(input)
					apiCalls.push(url)
					return url.endsWith('/export')
						? exportEnvelope('complete')
						: identityEnvelope(1_000)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async () => {
				downloadCalls += 1
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(step.uploadResults, [false, true])
	assert.equal(downloadCalls, 3)
	assert.equal(apiCalls.filter((url) => url.endsWith('/export')).length, 1)
	assert.equal(
		result.objectKey,
		objectKeyForBookmark(payload.objectPrefix, 'bookmark-1'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('workflow retry rejects an object tampered after upload and leaves the manifest absent', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const step = new RetryAfterCommitStep(() => {
		bucket.corrupt(objectKey, 'evil!')
	})
	let downloadCalls = 0
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			step,
			{
				api: {
					fetcher: async (input) =>
						String(input).endsWith('/export')
							? exportEnvelope('complete')
							: identityEnvelope(1_000),
					sleep: async () => undefined,
				},
				downloadFetcher: async () => {
					downloadCalls += 1
					return new Response('valid', {
						headers: { 'content-length': '5' },
					})
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'existing-object-source-mismatch' &&
			error.retryable === false,
	)
	assert.equal(downloadCalls, 2)
	assert.equal(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		null,
	)
	assert.equal(consoleError.mock.calls.length, 1)
})

test('cached upload result cannot bless a tampered manifest-less object', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const step = new CachedUploadStep(() => {
		bucket.corrupt(objectKey, 'evil!')
	})
	let downloadCalls = 0
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			step,
			{
				api: {
					fetcher: async (input) =>
						String(input).endsWith('/export')
							? exportEnvelope('complete')
							: identityEnvelope(1_000),
					sleep: async () => undefined,
				},
				downloadFetcher: async () => {
					downloadCalls += 1
					return new Response('valid', {
						headers: { 'content-length': '5' },
					})
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'existing-object-source-mismatch',
	)
	assert.equal(downloadCalls, 2)
	assert.equal(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		null,
	)
	assert.equal(consoleError.mock.calls.length, 1)
})

test('source verification and manifest commit share one Workflow step boundary', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	let finalizationObserved = false
	const step = new CachedUploadStep(
		() => undefined,
		async () => {
			finalizationObserved = true
			assert.notEqual(
				await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
				null,
			)
		},
	)
	await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		{
			api: {
				fetcher: async (input) =>
					String(input).endsWith('/export')
						? exportEnvelope('complete')
						: identityEnvelope(1_000),
				sleep: async () => undefined,
			},
			downloadFetcher: async () =>
				new Response('valid', {
					headers: { 'content-length': '5' },
				}),
		},
	)
	assert.equal(finalizationObserved, true)
})
test('workflow does not start D1 export when source size exceeds the ceiling', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	const env = environment()
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const urls: string[] = []
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			new RetryAfterCommitStep(),
			{
				api: {
					fetcher: async (input) => {
						urls.push(String(input))
						return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
					},
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	assert.equal(urls.length, 1)
	assert.equal(
		urls.some((url) => url.endsWith('/export')),
		false,
	)
	assert.equal(consoleError.mock.calls.length, 2)
})
