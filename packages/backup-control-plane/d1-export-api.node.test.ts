import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	DEFAULT_BACKUP_MAX_SOURCE_BYTES,
	pollD1Export,
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

test('startD1Export classifies auth, transient, and malformed responses', async () => {
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

	const malformedCases = [
		{
			response: new Response('{', { status: 200 }),
			code: 'api-malformed-json',
		},
		{
			response: Response.json({
				success: true,
				result: { status: 'complete' },
			}),
			code: 'export-malformed-response',
		},
		{
			response: exportEnvelope('error'),
			code: 'export-failed',
		},
		{
			response: Response.json({
				success: true,
				result: {
					type: 'export',
					success: true,
					at_bookmark: 'bookmark-1',
					status: 'weird',
				},
			}),
			code: 'export-malformed-response',
		},
	]
	for (const expected of malformedCases) {
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => expected.response.clone(),
				sleep: async () => undefined,
			}),
			(error: unknown) =>
				error instanceof BackupError && error.code === expected.code,
		)
	}
})

test('refresh requires the same bookmark and a complete nonempty signed URL', async () => {
	const cases = [
		{
			response: exportEnvelope('active'),
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

test('export poll and refresh workflow covers pending, expired, and malformed states', async () => {
	for (const response of [exportEnvelope(), exportEnvelope('active')]) {
		const result = await startD1Export(environment(), {
			fetcher: async () => response.clone(),
			sleep: async () => undefined,
		})
		assert.equal(result.kind, 'pending')
		assert.equal(result.bookmark, 'bookmark-1')
	}

	const lost = await pollD1Export(environment(), 'bookmark-1', {
		fetcher: async () => exportEnvelope('lost'),
		sleep: async () => undefined,
	})
	assert.equal(lost.kind, 'lost')

	await assert.rejects(
		pollD1Export(environment(), 'bookmark-1', {
			fetcher: async () =>
				Response.json({
					success: true,
					result: { success: false, error: 'something else' },
				}),
			sleep: async () => undefined,
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'export-malformed-response',
	)

	const bodies: unknown[] = []
	const responses = [
		exportEnvelope('lost'),
		exportEnvelope('active', 'bookmark-2'),
		exportEnvelope('complete', 'bookmark-2', 'https://download.example/fresh'),
	]
	const refreshed = await refreshCompletedD1Export(
		environment(),
		'bookmark-1',
		{
			fetcher: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)))
				return responses.shift()!
			},
			sleep: async () => undefined,
			earlyPollDelayMs: 1,
			pollDelayMs: 1,
		},
	)
	assert.equal(refreshed.kind, 'complete')
	assert.equal(refreshed.bookmark, 'bookmark-2')
	assert.equal(refreshed.signedUrl, 'https://download.example/fresh')
	assert.deepEqual(bodies, [
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-2' },
	])
})
