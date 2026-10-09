import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test, vi } from 'vitest'

import {
	d1ImportForeignKeysOffPrefix,
	importSqlIntoD1,
	prepareD1ImportUpload,
} from './d1-import-api.ts'
import { backupError } from './backup-control-plane-test-support.ts'

const SOURCE_SQL = 'CREATE TABLE t(id INTEGER);\n'
const SOURCE_MD5 = createHash('md5').update(SOURCE_SQL).digest('hex')
const UPLOAD_SQL = `${d1ImportForeignKeysOffPrefix}${SOURCE_SQL}`
const UPLOAD_MD5 = createHash('md5').update(UPLOAD_SQL).digest('hex')

/** Runs `importSqlIntoD1` against a fake D1 import API that answers polls in order. */
function runImport(
	pollResponses: Array<unknown>,
	{
		loadSqlBody = async (): Promise<string | ReadableStream<Uint8Array>> =>
			SOURCE_SQL,
		maxPollAttempts = 3,
	} = {},
) {
	const seen = {
		polls: 0,
		uploadedText: null as string | null,
		initEtag: null as string | null,
	}
	const fetcher: typeof fetch = async (input, init) => {
		if (String(input).includes('upload.example')) {
			seen.uploadedText = await new Response(init?.body).text()
			return new Response(null, { headers: { etag: `"${UPLOAD_MD5}"` } })
		}
		const body = JSON.parse(String(init?.body ?? '{}'))
		switch (body.action) {
			case 'init':
				seen.initEtag = typeof body.etag === 'string' ? body.etag : null
				return Response.json({
					success: true,
					result: {
						upload_url: 'https://upload.example/sql',
						filename: 'import.sql',
					},
				})
			case 'ingest':
				return Response.json({
					success: true,
					result: { at_bookmark: 'import-1', type: 'import' },
				})
			case 'poll': {
				const next = pollResponses[seen.polls++]
				if (next === undefined) throw new Error('unexpected extra poll')
				return Response.json({ success: true, result: next })
			}
			default:
				throw new Error(`unexpected action ${String(body.action)}`)
		}
	}
	const result = importSqlIntoD1({
		accountId: '11111111-1111-4111-8111-111111111111',
		databaseId: '22222222-2222-4222-8222-222222222222',
		token: 'token',
		sourceMd5Etag: SOURCE_MD5,
		loadSqlBody,
		options: {
			fetcher,
			sleep: async () => undefined,
			maxPollAttempts,
			pollDelayMs: 1,
		},
	})
	return { result, seen }
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
	assert.equal(new TextDecoder().decode(prepared.uploadBody), UPLOAD_SQL)

	await assert.rejects(
		prepareD1ImportUpload({
			sourceMd5Etag: 'b'.repeat(32),
			loadSqlBody: async () => SOURCE_SQL,
		}),
		backupError('import-source-etag-mismatch'),
	)
})

test('importSqlIntoD1 uploads FK-off-prefixed SQL and uses its MD5', async () => {
	const active = { type: 'import', success: true, status: 'active' }
	for (const terminal of [
		{ type: 'import', success: true, status: 'complete' },
		{
			type: 'import',
			success: true,
			result: { final_bookmark: 'final-1', num_queries: 1 },
		},
	]) {
		const { result, seen } = runImport([active, terminal])
		await result
		assert.deepEqual(seen, {
			polls: 2,
			uploadedText: UPLOAD_SQL,
			initEtag: UPLOAD_MD5,
		})
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
		let loads = 0
		const { result, seen } = runImport(
			[{ type: 'import', success: true, status: 'complete' }],
			{
				maxPollAttempts: 2,
				loadSqlBody: async () => {
					loads += 1
					return new Response(SOURCE_SQL).body!
				},
			},
		)
		await result
		assert.equal(loads, 2)
		assert.equal(seen.initEtag, UPLOAD_MD5)
		assert.equal(seen.uploadedText, UPLOAD_SQL)
		assert.deepEqual(constructedLengths, [
			new TextEncoder().encode(UPLOAD_SQL).byteLength,
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
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const pending = { type: 'import', success: true }
	for (const [responses, code] of [
		[[pending, pending, pending], 'import-poll-timeout'],
		[
			[{ success: false, error: 'Not currently importing anything.' }],
			'import-result-expired',
		],
		[
			[{ type: 'import', status: 'error', error: 'statement too long' }],
			'import-failed',
		],
	] as const) {
		const { result } = runImport([...responses])
		await assert.rejects(result, backupError(code))
	}
})
