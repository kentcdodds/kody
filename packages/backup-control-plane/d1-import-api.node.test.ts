import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test, vi } from 'vitest'

import {
	d1ImportForeignKeysOffPrefix,
	importSqlIntoD1,
	prepareD1ImportUpload,
} from './d1-import-api.ts'
import { BackupError } from './backup-policy.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const DATABASE = '22222222-2222-4222-8222-222222222222'
const SOURCE_SQL = 'CREATE TABLE t(id INTEGER);\n'
const SOURCE_MD5 = createHash('md5').update(SOURCE_SQL).digest('hex')
const UPLOAD_MD5 = createHash('md5')
	.update(d1ImportForeignKeysOffPrefix)
	.update(SOURCE_SQL)
	.digest('hex')

function importPollSequence(pollResponses: Array<unknown>) {
	let phase: 'init' | 'upload' | 'ingest' | 'poll' = 'init'
	let pollIndex = 0
	let uploadedText: string | null = null
	let initEtag: string | null = null
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input)
		if (url.includes('upload.example')) {
			phase = 'ingest'
			const body = init?.body
			if (typeof body === 'string') {
				uploadedText = body
			} else if (body instanceof Uint8Array) {
				uploadedText = new TextDecoder().decode(body)
			} else if (body instanceof ArrayBuffer) {
				uploadedText = new TextDecoder().decode(body)
			} else if (body instanceof ReadableStream) {
				const reader = body.getReader()
				const chunks: Array<Uint8Array> = []
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					if (value) chunks.push(value)
				}
				const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
				const merged = new Uint8Array(total)
				let offset = 0
				for (const chunk of chunks) {
					merged.set(chunk, offset)
					offset += chunk.byteLength
				}
				uploadedText = new TextDecoder().decode(merged)
			} else {
				throw new Error(`unexpected upload body type: ${typeof body}`)
			}
			return new Response(null, {
				status: 200,
				headers: { etag: `"${UPLOAD_MD5}"` },
			})
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			action?: string
			etag?: string
		}
		switch (body.action) {
			case 'init':
				phase = 'upload'
				initEtag = typeof body.etag === 'string' ? body.etag : null
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
		getUploadedText: () => uploadedText,
		getInitEtag: () => initEtag,
	}
}

test('prepareD1ImportUpload verifies source MD5 and prefixes foreign_keys=OFF', async () => {
	let loads = 0
	const prepared = await prepareD1ImportUpload({
		sourceMd5Etag: SOURCE_MD5,
		loadSqlBody: async () => {
			loads += 1
			return SOURCE_SQL
		},
	})
	assert.equal(loads, 2)
	assert.equal(prepared.uploadMd5Hex, UPLOAD_MD5)
	assert.equal(prepared.sourceBytes, SOURCE_SQL.length)
	assert.ok(prepared.uploadBody instanceof Uint8Array)
	assert.equal(
		new TextDecoder().decode(prepared.uploadBody),
		`${d1ImportForeignKeysOffPrefix}${SOURCE_SQL}`,
	)
})

test('prepareD1ImportUpload rejects source MD5 mismatches', async () => {
	await assert.rejects(
		prepareD1ImportUpload({
			sourceMd5Etag: 'b'.repeat(32),
			loadSqlBody: async () => SOURCE_SQL,
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'import-source-etag-mismatch',
	)
})

test('importSqlIntoD1 uploads FK-off-prefixed SQL and uses its MD5', async () => {
	for (const pollResponses of [
		[
			{ type: 'import', success: true, status: 'active' },
			{ type: 'import', success: true, status: 'complete' },
		],
		[
			{ type: 'import', success: true, status: 'active' },
			{
				type: 'import',
				success: true,
				result: { final_bookmark: 'final-1', num_queries: 1 },
			},
		],
	]) {
		const sequence = importPollSequence(pollResponses)
		await importSqlIntoD1({
			accountId: ACCOUNT,
			databaseId: DATABASE,
			token: 'token',
			sourceMd5Etag: SOURCE_MD5,
			loadSqlBody: async () => SOURCE_SQL,
			options: {
				fetcher: sequence.fetcher,
				sleep: async () => undefined,
				maxPollAttempts: 3,
				pollDelayMs: 1,
			},
		})
		assert.equal(sequence.getPollCount(), 2)
		assert.equal(sequence.getInitEtag(), UPLOAD_MD5)
		assert.equal(
			sequence.getUploadedText(),
			`${d1ImportForeignKeysOffPrefix}${SOURCE_SQL}`,
		)
	}
})

test('importSqlIntoD1 streams reopen through loadSqlBody and wraps uploads in FixedLengthStream when available', async () => {
	// Presigned D1 import upload URLs reject chunked bodies with HTTP 411;
	// the Workers runtime only emits Content-Length for FixedLengthStream.
	const constructedLengths: Array<number> = []
	class StubFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
		constructor(expectedLength: number) {
			super()
			constructedLengths.push(expectedLength)
		}
	}
	const globalWithStream = globalThis as { FixedLengthStream?: unknown }
	const previousFixedLengthStream = globalWithStream.FixedLengthStream
	globalWithStream.FixedLengthStream = StubFixedLengthStream
	try {
		const sequence = importPollSequence([
			{ type: 'import', success: true, status: 'complete' },
		])
		let loads = 0
		await importSqlIntoD1({
			accountId: ACCOUNT,
			databaseId: DATABASE,
			token: 'token',
			sourceMd5Etag: SOURCE_MD5,
			loadSqlBody: async () => {
				loads += 1
				return new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(SOURCE_SQL))
						controller.close()
					},
				})
			},
			options: {
				fetcher: sequence.fetcher,
				sleep: async () => undefined,
				maxPollAttempts: 2,
				pollDelayMs: 1,
			},
		})
		const expectedUpload = `${d1ImportForeignKeysOffPrefix}${SOURCE_SQL}`
		assert.equal(loads, 2)
		assert.equal(sequence.getInitEtag(), UPLOAD_MD5)
		assert.equal(sequence.getUploadedText(), expectedUpload)
		assert.deepEqual(constructedLengths, [
			new TextEncoder().encode(expectedUpload).byteLength,
		])
	} finally {
		if (previousFixedLengthStream === undefined) {
			delete globalWithStream.FixedLengthStream
		} else {
			globalWithStream.FixedLengthStream = previousFixedLengthStream
		}
	}
})

test('importSqlIntoD1 fails closed on non-terminal, expired, and error polls', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const cases: Array<{ responses: Array<unknown>; code: string }> = [
		{
			responses: [
				{ type: 'import', success: true },
				{ type: 'import', success: true },
				{ type: 'import', success: true },
			],
			code: 'import-poll-timeout',
		},
		{
			responses: [
				{
					success: false,
					error: 'Not currently importing anything.',
				},
			],
			code: 'import-result-expired',
		},
		{
			responses: [
				{
					type: 'import',
					status: 'error',
					error: 'statement too long',
				},
			],
			code: 'import-failed',
		},
	]
	for (const expected of cases) {
		const sequence = importPollSequence(expected.responses)
		await assert.rejects(
			importSqlIntoD1({
				accountId: ACCOUNT,
				databaseId: DATABASE,
				token: 'token',
				sourceMd5Etag: SOURCE_MD5,
				loadSqlBody: async () => SOURCE_SQL,
				options: {
					fetcher: sequence.fetcher,
					sleep: async () => undefined,
					maxPollAttempts: 3,
					pollDelayMs: 1,
				},
			}),
			(error: unknown) =>
				error instanceof BackupError && error.code === expected.code,
		)
	}
})
