import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { importSqlIntoD1 } from './d1-import-api.ts'
import { BackupError } from './backup-policy.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const DATABASE = '22222222-2222-4222-8222-222222222222'
const MD5 = 'a'.repeat(32)

function importPollSequence(pollResponses: Array<unknown>) {
	let phase: 'init' | 'upload' | 'ingest' | 'poll' = 'init'
	let pollIndex = 0
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input)
		if (url.includes('upload.example')) {
			phase = 'ingest'
			return new Response(null, {
				status: 200,
				headers: { etag: `"${MD5}"` },
			})
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			action?: string
		}
		switch (body.action) {
			case 'init':
				phase = 'upload'
				return Response.json({
					success: true,
					result: {
						upload_url: 'https://upload.example/sql',
						filename: 'import.sql',
					},
				})
			case 'ingest':
				phase = 'poll'
				return Response.json({
					success: true,
					result: { at_bookmark: 'import-1', type: 'import' },
				})
			case 'poll': {
				const next = pollResponses[pollIndex]
				pollIndex += 1
				if (next === undefined) {
					throw new Error(`unexpected extra poll (phase=${phase})`)
				}
				return Response.json({ success: true, result: next })
			}
			default:
				throw new Error(`unexpected action ${String(body.action)}`)
		}
	}
	return {
		fetcher,
		getPollCount: () => pollIndex,
	}
}

test('importSqlIntoD1 completes only on terminal status complete', async () => {
	const sequence = importPollSequence([
		{ type: 'import', success: true, status: 'active' },
		{ type: 'import', success: true, status: 'complete' },
	])
	await importSqlIntoD1({
		accountId: ACCOUNT,
		databaseId: DATABASE,
		token: 'token',
		sqlBody: 'CREATE TABLE t(id INTEGER);\n',
		md5Etag: MD5,
		options: {
			fetcher: sequence.fetcher,
			sleep: async () => undefined,
			maxPollAttempts: 3,
			pollDelayMs: 1,
		},
	})
	assert.equal(sequence.getPollCount(), 2)
})

test('importSqlIntoD1 completes on documented final_bookmark terminal shape', async () => {
	const sequence = importPollSequence([
		{ type: 'import', success: true, status: 'active' },
		{
			type: 'import',
			success: true,
			result: { final_bookmark: 'final-1', num_queries: 1 },
		},
	])
	await importSqlIntoD1({
		accountId: ACCOUNT,
		databaseId: DATABASE,
		token: 'token',
		sqlBody: 'CREATE TABLE t(id INTEGER);\n',
		md5Etag: MD5,
		options: {
			fetcher: sequence.fetcher,
			sleep: async () => undefined,
			maxPollAttempts: 3,
			pollDelayMs: 1,
		},
	})
	assert.equal(sequence.getPollCount(), 2)
})

test('importSqlIntoD1 does not treat bare success:true as completion', async () => {
	const sequence = importPollSequence([
		{ type: 'import', success: true },
		{ type: 'import', success: true },
		{ type: 'import', success: true },
	])
	await assert.rejects(
		importSqlIntoD1({
			accountId: ACCOUNT,
			databaseId: DATABASE,
			token: 'token',
			sqlBody: 'CREATE TABLE t(id INTEGER);\n',
			md5Etag: MD5,
			options: {
				fetcher: sequence.fetcher,
				sleep: async () => undefined,
				maxPollAttempts: 3,
				pollDelayMs: 1,
			},
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'import-poll-timeout',
	)
	assert.equal(sequence.getPollCount(), 3)
})

test('importSqlIntoD1 fails when poll expires before terminal success', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	await assert.rejects(
		importSqlIntoD1({
			accountId: ACCOUNT,
			databaseId: DATABASE,
			token: 'token',
			sqlBody: 'CREATE TABLE t(id INTEGER);\n',
			md5Etag: MD5,
			options: {
				fetcher: importPollSequence([
					{
						success: false,
						error: 'Not currently importing anything.',
					},
				]).fetcher,
				sleep: async () => undefined,
				maxPollAttempts: 3,
				pollDelayMs: 1,
			},
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'import-result-expired',
	)
})

test('importSqlIntoD1 fails on explicit error status', async () => {
	await assert.rejects(
		importSqlIntoD1({
			accountId: ACCOUNT,
			databaseId: DATABASE,
			token: 'token',
			sqlBody: 'CREATE TABLE t(id INTEGER);\n',
			md5Etag: MD5,
			options: {
				fetcher: importPollSequence([
					{
						type: 'import',
						status: 'error',
						error: 'statement too long',
					},
				]).fetcher,
				sleep: async () => undefined,
				maxPollAttempts: 3,
				pollDelayMs: 1,
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'import-failed' &&
			error.message === 'statement too long',
	)
})
