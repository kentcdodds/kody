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
	RetryFinalizationStep,
	RetryUploadStep,
	environment,
	exportEnvelope,
	identityEnvelope,
} from './backup-control-plane-test-support.ts'

test('zero live D1 size prevents export and a later restart can succeed', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	let liveSize = 0
	let exportCalls = 0
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) => {
				if (!String(input).endsWith('/export')) {
					return identityEnvelope(liveSize)
				}
				exportCalls += 1
				return exportEnvelope('complete')
			},
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}
	const event = {
		instanceId: workflowInstanceId(DATABASE_ID, payload.day),
		payload,
		timestamp: new Date('2026-07-22T02:15:01Z'),
	}

	await assert.rejects(
		runBackupRuntime(
			env,
			event,
			new CachedUploadStep(() => undefined),
			options,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-zero' &&
			error.retryable,
	)
	assert.equal(exportCalls, 0)
	assert.equal(bucket.puts.length, 0)

	liveSize = 1_000
	const result = await runBackupRuntime(
		env,
		event,
		new CachedUploadStep(() => undefined),
		options,
	)
	assert.equal(result.payload.sql.bytes, 5)
	assert.equal(exportCalls, 3)
})

test('workflow retry reuses an upload committed before step persistence and writes the absent manifest', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryAfterCommitStep()
	const apiCalls: string[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
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
					if (!url.endsWith('/export')) return identityEnvelope(1_000)
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						`https://download.example/url-${exportCalls}`,
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				downloadUrls.push(String(input))
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(step.uploadResults, [false, true])
	assert.deepEqual(downloadUrls, [
		'https://download.example/url-2',
		'https://download.example/url-3',
		'https://download.example/url-4',
	])
	assert.equal(apiCalls.filter((url) => url.endsWith('/export')).length, 4)
	assert.equal(
		result.payload.sql.objectKey,
		objectKeyForBookmark(payload.objectPrefix, 'bookmark-1'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('initial upload ignores a stale cached signed URL and refreshes it in the callback', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const exportBodies: unknown[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		new CachedUploadStep(() => undefined),
		{
			api: {
				fetcher: async (input, init) => {
					if (!String(input).endsWith('/export')) return identityEnvelope(1_000)
					exportBodies.push(JSON.parse(String(init?.body)))
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						[
							'https://download.example/stale-initial',
							'https://download.example/fresh-upload',
							'https://download.example/fresh-finalization',
						][exportCalls - 1],
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url === 'https://download.example/stale-initial') {
					return new Response('', { status: 403 })
				}
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(exportBodies, [
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
	])
	assert.deepEqual(downloadUrls, [
		'https://download.example/fresh-upload',
		'https://download.example/fresh-finalization',
	])
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('a finalization callback retry obtains another fresh signed URL', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryFinalizationStep()
	const downloadUrls: string[] = []
	let exportCalls = 0
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
					if (!String(input).endsWith('/export')) return identityEnvelope(1_000)
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						[
							'https://download.example/initial',
							'https://download.example/refreshed-upload',
							'https://download.example/refreshed-once',
							'https://download.example/refreshed-twice',
						][exportCalls - 1],
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url === 'https://download.example/refreshed-once') {
					return new Response('', { status: 503 })
				}
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.equal(exportCalls, 4)
	assert.deepEqual(step.finalizationAttempts, [1, 2])
	assert.deepEqual(downloadUrls, [
		'https://download.example/refreshed-upload',
		'https://download.example/refreshed-once',
		'https://download.example/refreshed-twice',
	])
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('zero-byte upload retries with a fresh URL before manifest success', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryUploadStep()
	let exportCalls = 0
	const downloadUrls: string[] = []
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
					if (!String(input).endsWith('/export')) return identityEnvelope(1_000)
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						`https://download.example/export-${String(exportCalls)}`,
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url.endsWith('export-2')) {
					return new Response('', { headers: { 'content-length': '0' } })
				}
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(step.uploadAttempts, [1, 2])
	assert.deepEqual(downloadUrls, [
		'https://download.example/export-2',
		'https://download.example/export-3',
		'https://download.example/export-4',
	])
	assert.equal(result.payload.sql.bytes, 5)
	assert.equal(
		bucket.puts.filter(({ key }) => key === result.payload.sql.objectKey)
			.length,
		1,
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

test('manifest signing failure leaves committed SQL manifest-less and retry succeeds', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const validPrivateKey = env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64
	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 =
		Buffer.from('invalid-pkcs8').toString('base64')
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const step = new CachedUploadStep(() => undefined)
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) =>
				String(input).endsWith('/export')
					? exportEnvelope('complete')
					: identityEnvelope(1_000),
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			step,
			options,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-signing-failed',
	)
	assert.notEqual(await bucket.head(objectKey), null)
	assert.equal(await bucket.head(payload.manifestKey), null)

	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 = validPrivateKey
	await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		options,
	)
	assert.notEqual(await bucket.head(payload.manifestKey), null)
	assert.equal(consoleError.mock.calls.length, 1)
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
