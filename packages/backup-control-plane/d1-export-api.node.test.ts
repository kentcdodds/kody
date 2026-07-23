import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	DEFAULT_BACKUP_MAX_SOURCE_BYTES,
	refreshCompletedD1Export,
	startD1Export,
	verifySourceDatabaseIdentity,
} from './d1-export-api.ts'
import { BackupError } from './backup-policy.ts'
import {
	DATABASE_ID,
	environment,
	exportEnvelope,
	identityEnvelope,
} from './backup-control-plane-test-support.ts'

test('verifies D1 identity size gates without calling the live account endpoint', async () => {
	const consoleError = vi.spyOn(console, 'error')
	const consoleLog = vi.spyOn(console, 'log')
	consoleError.mockImplementation(() => undefined)
	consoleLog.mockImplementation(() => undefined)

	const urls: string[] = []
	await verifySourceDatabaseIdentity(environment(), {
		fetcher: async (input) => {
			urls.push(String(input))
			return Response.json({
				success: true,
				result: {
					uuid: DATABASE_ID,
					name: 'production-db',
					file_size: 1_000,
				},
			})
		},
		sleep: async () => undefined,
	})
	assert.equal(urls.length, 1)
	assert.match(urls[0]!, /\/d1\/database\//)

	consoleError.mockClear()
	for (const response of [
		identityEnvelope(undefined, false),
		identityEnvelope('1000'),
		identityEnvelope(1.5),
		identityEnvelope(-1),
	]) {
		await assert.rejects(
			verifySourceDatabaseIdentity(environment(), {
				fetcher: async () => response.clone(),
			}),
			(error: unknown) =>
				error instanceof BackupError && error.code === 'api-malformed-identity',
		)
	}
	assert.deepEqual(
		await verifySourceDatabaseIdentity(environment(), {
			fetcher: async () =>
				identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES - 1),
		}),
		{
			fileSize: DEFAULT_BACKUP_MAX_SOURCE_BYTES - 1,
			maxSourceBytes: DEFAULT_BACKUP_MAX_SOURCE_BYTES,
		},
	)
	assert.equal(consoleError.mock.calls.length, 4)

	consoleError.mockClear()
	consoleLog.mockClear()
	await assert.rejects(
		verifySourceDatabaseIdentity(environment(), {
			fetcher: async () => identityEnvelope(0),
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-zero' &&
			error.retryable,
	)
	assert.equal(consoleError.mock.calls.length, 1)
	assert.deepEqual(
		await verifySourceDatabaseIdentity(environment(), {
			fetcher: async () => identityEnvelope(1_000),
		}),
		{ fileSize: 1_000, maxSourceBytes: DEFAULT_BACKUP_MAX_SOURCE_BYTES },
	)
	assert.equal(consoleLog.mock.calls.length, 1)

	consoleError.mockClear()
	for (const fileSize of [
		DEFAULT_BACKUP_MAX_SOURCE_BYTES,
		DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1,
	]) {
		await assert.rejects(
			verifySourceDatabaseIdentity(environment(), {
				fetcher: async () => identityEnvelope(fileSize),
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'source-size-limit-exceeded',
		)
	}
	const env = environment()
	env.BACKUP_MAX_SOURCE_BYTES = '100'
	await assert.rejects(
		verifySourceDatabaseIdentity(env, {
			fetcher: async () => identityEnvelope(100),
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	env.BACKUP_MAX_SOURCE_BYTES = String(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
	await assert.rejects(
		verifySourceDatabaseIdentity(env, {
			fetcher: async () => identityEnvelope(1),
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'invalid-max-source-bytes',
	)
	assert.equal(consoleError.mock.calls.length, 3)
})

test('startD1Export classifies auth failures as non-retryable and retries transient statuses', async () => {
	for (const status of [401, 403]) {
		let calls = 0
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => {
					calls += 1
					return new Response('', { status })
				},
				sleep: async () => undefined,
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'api-auth-failure' &&
				error.retryable === false,
		)
		assert.equal(calls, 1)
	}

	for (const status of [429, 500, 503]) {
		let calls = 0
		const sleeps: number[] = []
		const result = await startD1Export(environment(), {
			fetcher: async () => {
				calls += 1
				return calls === 1
					? new Response('', {
							status,
							headers: status === 429 ? { 'retry-after': '2' } : {},
						})
					: exportEnvelope('complete')
			},
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds)
			},
		})
		assert.equal(result.kind, 'complete')
		assert.equal(calls, 2)
		assert.equal(sleeps[0], status === 429 ? 2_000 : 1_000)
	}
})

test('rejects malformed JSON and malformed/error export payloads', async () => {
	for (const response of [
		new Response('{', { status: 200 }),
		Response.json({ success: true, result: { status: 'complete' } }),
		exportEnvelope('error'),
	]) {
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => response.clone(),
				sleep: async () => undefined,
			}),
			BackupError,
		)
	}
})

test('refresh requires the same bookmark and a complete nonempty signed URL', async () => {
	const cases = [
		{
			response: exportEnvelope(),
			code: 'export-refresh-pending',
			retryable: true,
		},
		{
			response: exportEnvelope('complete', 'bookmark-2'),
			code: 'export-bookmark-mismatch',
			retryable: false,
		},
		{
			response: exportEnvelope('complete', 'bookmark-1', ''),
			code: 'export-malformed-response',
			retryable: false,
		},
	]
	for (const expected of cases) {
		await assert.rejects(
			refreshCompletedD1Export(environment(), 'bookmark-1', {
				fetcher: async () => expected.response.clone(),
				sleep: async () => undefined,
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === expected.code &&
				error.retryable === expected.retryable,
		)
	}
})
