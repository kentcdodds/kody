import { expect, test, vi } from 'vitest'
import { stagingSummaryKey } from '@kody-internal/shared/backup-staging.ts'
import { handleDrExportRequest } from '#worker/dr/dr-export-maintenance.ts'
import { runDrExportTick } from '#worker/dr/exporter.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'

const storageMocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		exportStorage: storageMocks.exportStorage,
	}),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		exportMailbox: vi.fn(),
	}),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	runLogRpc: () => ({
		exportRuns: vi.fn(),
	}),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listPlatformStorageBuckets: vi.fn(
		async () => [] as Array<{ userId: string; storageId: string }>,
	),
	listUserStorageBucketIds: vi.fn(async () => []),
	registerStorageBucket: vi.fn(),
}))

function etagFor(bytes: Uint8Array) {
	let hash = 0
	for (const value of bytes) hash = (hash * 31 + value) >>> 0
	return `"${hash.toString(16)}"`
}

function createMemoryS3() {
	const objects = new Map<string, { bytes: Uint8Array; etag: string }>()
	const client: DrBackupS3Client = {
		async head(key) {
			const entry = objects.get(key)
			return entry
				? { exists: true, status: 200, etag: entry.etag }
				: { exists: false, status: 404, etag: null }
		},
		async getText(key) {
			const entry = objects.get(key)
			if (!entry) return null
			return {
				text: new TextDecoder().decode(entry.bytes),
				etag: entry.etag,
			}
		},
		async getBytes(key) {
			return objects.get(key)?.bytes ?? null
		},
		async put(key, body, options: DrBackupS3PutOptions = {}) {
			const existing = objects.get(key)
			if (options.ifNoneMatch === '*' && existing) {
				throw new DrBackupPreconditionFailedError(key)
			}
			if (options.ifMatch) {
				if (!existing || existing.etag !== options.ifMatch) {
					throw new DrBackupPreconditionFailedError(key)
				}
			}
			const bytes =
				typeof body === 'string' ? new TextEncoder().encode(body) : body
			const etag = etagFor(bytes)
			objects.set(key, { bytes, etag })
			return { etag }
		},
	}
	return { client, objects }
}

function createDb() {
	return {
		prepare(sql: string) {
			return {
				all: async () => {
					if (sql.includes('FROM jobs')) {
						return {
							results: [
								{ userId: 'user-a', storageId: 'job:1' },
								{ userId: 'user-a', storageId: 'job:2' },
							],
						}
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

function createR2() {
	return {
		async list() {
			return { objects: [], truncated: false, cursor: '' }
		},
		async get() {
			return null
		},
	} as unknown as R2Bucket
}

function createEnv(client: DrBackupS3Client) {
	return {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		DR_RESTORE_SECRET: 'operator-secret',
		APP_DB: createDb(),
		EMAIL_BLOBS: createR2(),
		COMMUNITY_ASSETS: createR2(),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
	} as unknown as Env & { __s3?: DrBackupS3Client }
}

function postRequest(body: unknown, secret = 'operator-secret') {
	return new Request('https://worker.example/__maintenance/dr-export', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${secret}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

test('dr-export maintenance finishes a stranded day, then reports it complete', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'k', value: 1 }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 1,
	})
	const { client } = createMemoryS3()
	const env = createEnv(client)
	let nowMs = 1_000_000
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		// Strand the night: exhaust the budget after the first storage dump.
		if (key.includes('/storage/') && key.endsWith('.ndjson')) {
			nowMs += 50_000
		}
		return result
	}

	try {
		const nightly = await runDrExportTick({
			env,
			now: new Date('2026-07-23T06:10:00.000Z'),
			timeBudgetMs: 20_000,
			s3: client,
		})
		expect(nightly.summaryWritten).toBe(false)
		nowMs = 1_000_000
		client.put = originalPut

		const response = await handleDrExportRequest(
			postRequest({ day: '2026-07-23' }),
			env,
			client,
		)
		expect(response.status).toBe(200)
		const result = (await response.json()) as {
			ok: boolean
			day: string
			summaryWritten: boolean
			ticks: Array<{ mode: string }>
		}
		expect(result).toMatchObject({
			ok: true,
			day: '2026-07-23',
			summaryWritten: true,
		})
		expect(result.ticks.every((tick) => tick.mode === 'operator')).toBe(true)
		expect(await client.getText(stagingSummaryKey('2026-07-23'))).toBeTruthy()

		const again = await handleDrExportRequest(
			postRequest({ day: '2026-07-23' }),
			env,
			client,
		)
		expect(await again.json()).toMatchObject({
			ok: true,
			summaryWritten: false,
			skipped: true,
			reason: 'already-complete',
		})

		const neverStaged = await handleDrExportRequest(
			postRequest({ day: '2026-07-20', maxTicks: 2 }),
			env,
			client,
		)
		expect(await neverStaged.json()).toMatchObject({
			ok: true,
			summaryWritten: false,
			skipped: true,
			reason: 'no-staged-progress',
		})
	} finally {
		dateNow.mockRestore()
	}
})

test('dr-export maintenance enforces auth, configuration, and input validation', async () => {
	const { client } = createMemoryS3()
	const env = createEnv(client)

	const nonPost = await handleDrExportRequest(
		new Request('https://worker.example/__maintenance/dr-export'),
		env,
		client,
	)
	expect(nonPost.status).toBe(405)

	const unconfigured = await handleDrExportRequest(
		postRequest({ day: '2026-07-23' }),
		{ ...env, DR_RESTORE_SECRET: undefined } as unknown as Env,
		client,
	)
	expect(unconfigured.status).toBe(503)

	const badBearer = await handleDrExportRequest(
		postRequest({ day: '2026-07-23' }, 'wrong-secret'),
		env,
		client,
	)
	expect(badBearer.status).toBe(401)

	const missingDay = await handleDrExportRequest(postRequest({}), env, client)
	expect(missingDay.status).toBe(500)
	expect(await missingDay.json()).toMatchObject({
		ok: false,
		error: 'Request body requires day: string',
	})

	const invalidDay = await handleDrExportRequest(
		postRequest({ day: '23-07-2026' }),
		env,
		client,
	)
	expect(invalidDay.status).toBe(500)
	expect(await invalidDay.json()).toMatchObject({
		ok: false,
		error: 'day must be a UTC YYYY-MM-DD day',
	})

	const invalidTicks = await handleDrExportRequest(
		postRequest({ day: '2026-07-23', maxTicks: 99 }),
		env,
		client,
	)
	expect(invalidTicks.status).toBe(500)
	expect(await invalidTicks.json()).toMatchObject({
		ok: false,
		error: 'maxTicks must be an integer between 1 and 10',
	})

	const futureDay = await handleDrExportRequest(
		postRequest({ day: '2999-01-01' }),
		env,
		client,
	)
	expect(futureDay.status).toBe(500)
	expect(await futureDay.json()).toMatchObject({
		ok: false,
		error: expect.stringContaining('future'),
	})
})
