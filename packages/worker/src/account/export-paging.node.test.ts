import { expect, test, vi } from 'vitest'
import {
	createAccountExport,
	createAccountExportManifest,
	readAccountExportSection,
} from './export.ts'
import {
	createMigratedDb,
	createMailboxBinding,
	createSignedR2Cursor,
} from '#worker/test-support/account-export.ts'

test('R2 export pages owned payloads in bounded chunks and reports missing objects', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, avatar_key
		) VALUES
			(1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-aaa', 'user-avatars/user-aaa/avatar.png'),
			(2, 'user-b', 'b@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-bbb', 'user-avatars/user-bbb/avatar.png');
	`)
	const mimeBytes = new TextEncoder().encode('Subject: A\r\n\r\nbody')
	const getEmailBlob = vi.fn(async (key: string) => {
		if (key === 'email-raw:v1:user-aaa/mail-z') {
			throw new Error('temporary R2 outage')
		}
		if (key !== 'email-raw:v1:user-aaa/mail-a') return null
		return {
			size: mimeBytes.byteLength,
			httpEtag: '"etag-a"',
			httpMetadata: { contentType: 'message/rfc822' },
			arrayBuffer: async () => mimeBytes.buffer,
		}
	})
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get: getEmailBlob },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () => [
				{
					kind: 'raw_mime',
					key: 'email-raw:v1:user-aaa/mail-a',
					messageId: 'mail-a',
					attachmentId: null,
				},
				{
					kind: 'raw_mime',
					key: 'email-raw:v1:user-aaa/mail-z',
					messageId: 'mail-z',
					attachmentId: null,
				},
			],
		}),
	} as unknown as Env

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(first.items).toEqual([
		expect.objectContaining({
			surfaceId: 'user_avatar',
			key: 'user-avatars/user-aaa/avatar.png',
			missing: true,
		}),
	])
	const firstCursor = first.nextStartAfter!
	const tamperedCursor = `${firstCursor.slice(0, -1)}${firstCursor.endsWith('a') ? 'b' : 'a'}`
	await expect(
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'r2_object',
			startAfter: tamperedCursor,
		}),
	).rejects.toThrow('Invalid or unsupported r2_object cursor')
	const legacyCursor = await createSignedR2Cursor({
		secret: 'test-cookie-secret',
		userId: 'user-aaa',
		cursor: {
			v: 1,
			state: { stage: 'email_raw_mime', afterRowid: 1 },
		},
	})
	await expect(
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'r2_object',
			startAfter: legacyCursor,
		}),
	).rejects.toThrow('restart without startAfter')
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({
			surfaceId: 'email_raw_mime',
			key: 'email-raw:v1:user-aaa/mail-a',
			contentBase64: btoa('Subject: A\r\n\r\nbody'),
			objectComplete: true,
		}),
	])
	expect(second.truncated).toBe(true)
	const third = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: second.nextStartAfter ?? undefined,
	})
	expect(third.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-z',
			unavailable: true,
		}),
	])
	expect(third.truncated).toBe(true)
	expect(third.warnings).toEqual([
		expect.stringContaining('R2 object export failed'),
	])
	const done = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: third.nextStartAfter ?? undefined,
	})
	expect(done.items).toEqual([])
	expect(done.truncated).toBe(false)
	expect(getEmailBlob).not.toHaveBeenCalledWith(
		'email-raw:v1:user-bbb/mail-b',
		expect.anything(),
	)
})

test('R2 export performs bounded keyset work independent of mailbox size', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createMigratedDb({
		onQuery: (query) => queries.push(query),
	})
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa'
		);
	`)
	const page = await readAccountExportSection({
		env: {
			APP_DB: db,
			COOKIE_SECRET: 'test-cookie-secret',
			EMAIL_BLOBS: { get: vi.fn(async () => null) },
			COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
			MAILBOX: createMailboxBinding({
				blobReferences: () =>
					Array.from({ length: 502 }, (_, index) => {
						const messageId = `mail-${String(index).padStart(4, '0')}`
						return {
							kind: 'raw_mime' as const,
							key: `email-raw:v1:user-aaa/${messageId}`,
							messageId,
							attachmentId: null,
						}
					}),
			}),
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(page.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-0000',
			missing: true,
		}),
	])
	expect(queries.length).toBeLessThanOrEqual(4)
	expect(
		queries.some(
			(query) => query === 'SELECT id FROM email_messages WHERE user_id = ?',
		),
	).toBe(false)
})

test('R2 export cursor detects object overwrite before continuing bytes', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, avatar_key
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa', 'user-avatars/user-aaa/avatar.png'
		);
	`)
	const bytes = new Uint8Array(300 * 1024).fill(1)
	let etag = '"v1"'
	const get = vi.fn(
		async (
			_key: string,
			options?: { range?: { offset: number; length: number } },
		) => {
			const offset = options?.range?.offset ?? 0
			const length = options?.range?.length ?? bytes.byteLength
			const chunk = bytes.slice(offset, offset + length)
			return {
				size: bytes.byteLength,
				httpEtag: etag,
				httpMetadata: { contentType: 'image/png' },
				arrayBuffer: async () => chunk.buffer,
			}
		},
	)
	const head = vi.fn(async () => ({
		size: bytes.byteLength,
		httpEtag: etag,
	}))
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		COMMUNITY_ASSETS: { get, head },
		EMAIL_BLOBS: { get: vi.fn(async () => null), head },
	} as unknown as Env
	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(first.items).toEqual([
		expect.objectContaining({
			offset: 0,
			etag: '"v1"',
			objectComplete: false,
		}),
	])
	etag = '"v2"'
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({
			changed: true,
			change: 'object_overwritten',
			expectedEtag: '"v1"',
			actualEtag: '"v2"',
		}),
	])
	expect(get).toHaveBeenCalledTimes(1)
})

test('R2 export cursor keeps stable row identity when inventory mutates', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa'
		);
	`)
	const requestedKeys: Array<string> = []
	const get = vi.fn(async (key: string) => {
		requestedKeys.push(key)
		const bytes = new TextEncoder().encode(key)
		return {
			size: bytes.byteLength,
			httpEtag: `"${key}"`,
			arrayBuffer: async () => bytes.buffer,
		}
	})
	const blobReferences = [
		{
			kind: 'raw_mime' as const,
			key: 'email-raw:v1:user-aaa/mail-a',
			messageId: 'mail-a',
			attachmentId: null,
		},
		{
			kind: 'raw_mime' as const,
			key: 'email-raw:v1:user-aaa/mail-b',
			messageId: 'mail-b',
			attachmentId: null,
		},
	]
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () => blobReferences,
		}),
	} as unknown as Env
	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	blobReferences.unshift({
		kind: 'raw_mime',
		key: 'email-raw:v1:user-aaa/mail-00',
		messageId: 'mail-00',
		attachmentId: null,
	})
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({ key: 'email-raw:v1:user-aaa/mail-b' }),
	])
	expect(requestedKeys).toEqual([
		'email-raw:v1:user-aaa/mail-a',
		'email-raw:v1:user-aaa/mail-b',
	])
})

test('durable object discovery pages high-cardinality storage ids without nested arrays', async () => {
	const ids = Array.from(
		{ length: 502 },
		(_, index) => `storage-${String(index).padStart(4, '0')}`,
	)
	let maxRows = 0
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							if (query.includes('FROM user_storage_buckets')) {
								if (!query.includes('storage_id > ?')) {
									return { results: [] as Array<T> }
								}
								const afterId = String(params[1])
								const limit = Number(params[2])
								const rows = ids
									.filter((id) => id > afterId)
									.slice(0, limit)
									.map((id) => ({ id }))
								maxRows = Math.max(maxRows, rows.length)
								return { results: rows as Array<T> }
							}
							throw new Error(`Unexpected query: ${query}`)
						},
						async first<T>() {
							return null as T | null
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const seen = new Set<string>()
	let startAfter: string | undefined
	for (;;) {
		const page = await readAccountExportSection({
			env: {
				APP_DB: db,
				JOBS: { listJobStorageIdsForUser: async () => [] },
			} as unknown as Env,
			dbUserId: 1,
			mcpUserId: 'user-a',
			section: 'durable_object_summaries',
			kind: 'storage_runner',
			pageSize: 100,
			startAfter,
		})
		for (const item of page.items as Array<{ storageId: string }>) {
			expect(Array.isArray(item.storageId)).toBe(false)
			seen.add(item.storageId)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(seen.size).toBe(502)
	expect(maxRows).toBeLessThanOrEqual(101)
})

test('account export includes run_records section with runs, ledger, and dedicated state', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const run = {
		id: 'run-export-1',
		surface: 'job' as const,
		status: 'success' as const,
		name: 'nightly',
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: 'job:nightly',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-26T00:00:00.000Z',
		finishedAt: '2026-07-26T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: {},
		logCount: 2,
	}
	const logs = [
		{
			runId: 'run-export-1',
			sequence: 0,
			level: 'log' as const,
			message: 'starting',
			fields: null,
		},
		{
			runId: 'run-export-1',
			sequence: 1,
			level: 'info' as const,
			message: 'done',
			fields: { ok: true },
		},
	]
	// Keyed package-invocation idempotency ledger row stored in the same
	// RunLog DO; exported through the same run_records section.
	const packageInvocation = {
		id: 'invocation-export-1',
		tokenId: 'token-1',
		packageId: 'pkg-1',
		packageKodyId: 'pkg-one',
		exportName: './send-message',
		idempotencyKey: 'evt-1',
		requestHash: 'hash-1',
		source: 'webhook',
		topic: null,
		status: 'completed' as const,
		responseJson: '{"status":200,"body":{"ok":true}}',
		createdAt: '2026-07-26T00:00:00.000Z',
		updatedAt: '2026-07-26T00:00:01.000Z',
	}
	const workflowProjection = {
		id: 'wf-export-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline' as const,
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'export-wf',
		exportName: null,
		idempotencyKey: 'idem-export',
		runAt: '2026-07-31T00:00:00.000Z',
		planDate: null,
		status: 'complete',
		createdAt: '2026-07-31T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:01.000Z',
		completedAt: '2026-07-31T00:00:01.000Z',
		lastError: null,
	}
	const jobRunObservability = {
		jobId: 'job-export-1',
		lastRunAt: '2026-07-31T00:00:00.000Z',
		lastRunStatus: 'success' as const,
		lastRunError: null,
		lastDurationMs: 12,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		updatedAt: '2026-07-31T00:00:01.000Z',
	}
	const packageRunSuccess = {
		packageId: 'pkg-1',
		successCount: 2,
		updatedAt: '2026-07-31T00:00:01.000Z',
	}
	const activationMilestone = {
		milestone: 'package_activated' as const,
		reachedAt: '2026-07-31T00:00:01.000Z',
		packageId: 'pkg-1',
	}
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				exportStorage: async () => ({
					entries: [],
					truncated: false,
					nextStartAfter: null,
					pageSize: 100,
				}),
			}),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				exportRuns: async () => ({
					runs: [run],
					logs,
					packageInvocations: [packageInvocation],
					workflowProjections: [workflowProjection],
					jobRunObservability: [jobRunObservability],
					packageRunSuccesses: [packageRunSuccess],
					activationMilestones: [activationMilestone],
					nextStartAfter: null,
					truncated: false,
				}),
				listStorageIds: async () => ['job:nightly'],
				summarize: async () => ({
					since: '1970-01-01T00:00:00.000Z',
					total: 1,
					errors: 0,
					ignored: 0,
					resolved: 0,
					running: 0,
					bySurface: [],
				}),
			}),
		},
		JOBS: {
			exportUser: async () => ({ userId: 'user-aaa' }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	// One run plus one row from each RunLog export phase.
	expect(accountExport.manifest.sections.run_records?.count).toBe(6)
	expect(accountExport.durableObjects.runRecords).toEqual({
		runs: [run],
		logs,
		packageInvocations: [packageInvocation],
		workflowProjections: [workflowProjection],
		jobRunObservability: [jobRunObservability],
		packageRunSuccesses: [packageRunSuccess],
		activationMilestones: [activationMilestone],
		nextStartAfter: null,
		truncated: false,
	})

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
	})
	expect(section.truncated).toBe(false)
	expect(section.items).toEqual([
		{
			run,
			logs,
		},
		{
			packageInvocation,
		},
		{
			workflowProjection,
		},
		{
			jobRunObservability,
		},
		{
			packageRunSuccess,
		},
		{
			activationMilestone,
		},
	])
})

test('account export includes user_meter counters, pages them, and warns on truncation', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const counters = [
		{
			resource: 'email_sends_per_day' as const,
			day: '2026-07-30',
			count: 2,
			revision: 2,
			updatedAt: '2026-07-30T01:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000002',
		},
		{
			resource: 'execute_calls_per_day' as const,
			day: '2026-07-30',
			count: 5,
			revision: 5,
			updatedAt: '2026-07-30T02:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000005',
		},
		{
			resource: 'outbound_fetches_per_day' as const,
			day: '2026-07-31',
			count: 1,
			revision: 1,
			updatedAt: '2026-07-31T00:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000001',
		},
	]
	const storageBytesState = {
		bytes: 4_096,
		revision: 3,
		updatedAt: '2026-07-31T03:00:00.000Z',
		mirrorUpdatedAt: 'r/00000000000000000003',
	}
	const deletionState = {
		deletingAt: '2026-07-31 03:10:00' as string | null,
		activeWriteLeaseCount: 1,
		writeLeases: [
			{
				acquiredAt: '2026-07-31 03:00:00',
			},
		],
	}
	const exportCounters = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? counters.findIndex(
						(row) => `${row.day}:${row.resource}` === input.startAfter,
					) + 1
				: 0
			const page = counters.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < counters.length
			const isFirstPage =
				typeof input.startAfter !== 'string' || input.startAfter.length === 0
			return {
				counters: page,
				storageBytesState: isFirstPage ? storageBytesState : null,
				deletionState: isFirstPage ? deletionState : null,
				nextStartAfter: truncated
					? `${page.at(-1)!.day}:${page.at(-1)!.resource}`
					: null,
				truncated,
			}
		},
	)
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		USER_METER: {
			idFromName,
			get: () => ({ exportCounters }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	// 3 counters + storage state + deletingAt + 1 lease
	expect(accountExport.manifest.sections.user_meter?.count).toBe(6)
	expect(accountExport.durableObjects.userMeter).toEqual({
		counters,
		storageBytesState,
		deletionState,
		nextStartAfter: null,
		truncated: false,
	})
	expect(accountExport.manifest.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('entitlement_daily_counters'),
		]),
	)

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'user_meter',
		pageSize: 2,
	})
	expect(first.items).toEqual(counters.slice(0, 2))
	expect(first.storageBytesState).toEqual(storageBytesState)
	expect(first.deletionState).toEqual(deletionState)
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('2026-07-30:execute_calls_per_day')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'user_meter',
		pageSize: 2,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual(counters.slice(2))
	expect(second.storageBytesState).toBeNull()
	expect(second.deletionState).toBeNull()
	expect(second.truncated).toBe(false)
	expect(second.nextStartAfter).toBeNull()
	expect(exportCounters).toHaveBeenCalledWith(
		expect.objectContaining({
			pageSize: 2,
			startAfter: first.nextStartAfter,
		}),
	)

	exportCounters.mockImplementation(async () => ({
		counters: [counters[0]!],
		storageBytesState: null,
		deletionState: null,
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(truncatedExport.durableObjects.userMeter?.truncated).toBe(true)
	expect(truncatedExport.manifest.sections.user_meter?.count).toBe(1)
	expect(truncatedExport.manifest.warnings).toContain(
		'User meter counters were truncated in the full export; use account_export_section with section "user_meter" to retrieve additional pages.',
	)
})

test('account export includes mailbox rows, pages them, and warns on truncation', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const rows = [
		{
			kind: 'thread' as const,
			row: {
				id: 'thread-1',
				inboxId: 'inbox-1',
				subjectNormalized: 'hello',
				rootMessageIdHeader: null,
				lastMessageAt: '2026-07-30T00:00:00.000Z',
				createdAt: '2026-07-30T00:00:00.000Z',
				updatedAt: '2026-07-30T00:00:00.000Z',
			},
		},
		{
			kind: 'message' as const,
			row: {
				id: 'message-1',
				threadId: 'thread-1',
				inboxId: 'inbox-1',
				direction: 'inbound' as const,
				processingStatus: 'received' as const,
				deliveryStatus: 'delivered' as const,
				classification: 'personal' as const,
				subject: 'hello',
				fromAddress: 'a@example.com',
				toAddresses: ['b@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				replyToAddresses: [],
				messageIdHeader: null,
				inReplyToHeader: null,
				referencesHeader: null,
				sentAt: '2026-07-30T00:00:00.000Z',
				receivedAt: '2026-07-30T00:00:00.000Z',
				rawMimeKey: null,
				rawMimeStorageKind: 'unavailable' as const,
				bodyText: 'hi',
				bodyHtml: null,
				snippet: 'hi',
				hasAttachments: false,
				createdAt: '2026-07-30T00:00:00.000Z',
				updatedAt: '2026-07-30T00:00:00.000Z',
			},
		},
		{
			kind: 'attachment' as const,
			row: {
				id: 'attachment-1',
				messageId: 'message-1',
				filename: 'file.txt',
				contentType: 'text/plain',
				sizeBytes: 3,
				storageKey: null,
				storageKind: 'unavailable' as const,
				contentId: null,
				isInline: false,
				createdAt: '2026-07-30T00:00:00.000Z',
			},
		},
	]
	const exportMailbox = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? rows.findIndex((row) => row.row.id === input.startAfter) + 1
				: 0
			const page = rows.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < rows.length
			return {
				rows: page,
				nextStartAfter: truncated ? page.at(-1)!.row.id : null,
				truncated,
			}
		},
	)
	const countMailbox = vi.fn(async () => ({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 0,
	}))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		MAILBOX: {
			idFromName,
			get: () => ({ exportMailbox, countMailbox }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	expect(accountExport.manifest.sections.mailbox?.count).toBe(3)
	expect(accountExport.durableObjects.mailbox).toEqual({
		rows,
		nextStartAfter: null,
		truncated: false,
	})
	for (const table of [
		'email_threads',
		'email_messages',
		'email_attachments',
		'email_delivery_events',
	]) {
		expect(accountExport.d1).not.toHaveProperty(table)
		expect(accountExport.manifest.sections).not.toHaveProperty(`d1.${table}`)
	}

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'mailbox',
		pageSize: 2,
	})
	expect(first.items).toEqual(rows.slice(0, 2))
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('message-1')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'mailbox',
		pageSize: 2,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual(rows.slice(2))
	expect(second.truncated).toBe(false)
	expect(second.nextStartAfter).toBeNull()
	expect(exportMailbox).toHaveBeenCalled()

	exportMailbox.mockImplementation(async () => ({
		rows: [rows[0]!],
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(truncatedExport.durableObjects.mailbox?.truncated).toBe(true)
	expect(truncatedExport.manifest.warnings).toContain(
		'Mailbox rows were truncated in the full export; use account_export_section with section "mailbox" to retrieve additional pages.',
	)
})

test('run_records section paging preserves exportRuns cursor across dedicated phases', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const run = {
		id: 'run-page-1',
		surface: 'job' as const,
		status: 'success' as const,
		name: 'page',
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: 'job-page',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-26T00:00:00.000Z',
		finishedAt: '2026-07-26T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: {},
		logCount: 0,
	}
	const workflowProjection = {
		id: 'wf-page-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline' as const,
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'page-wf',
		exportName: null,
		idempotencyKey: 'idem-page',
		runAt: '2026-07-31T00:00:00.000Z',
		planDate: null,
		status: 'complete',
		createdAt: '2026-07-31T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:01.000Z',
		completedAt: '2026-07-31T00:00:01.000Z',
		lastError: null,
	}
	const exportRuns = vi
		.fn()
		.mockResolvedValueOnce({
			runs: [run],
			logs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: 'invocation-ledger:',
			truncated: true,
		})
		.mockResolvedValueOnce({
			runs: [],
			logs: [],
			packageInvocations: [],
			workflowProjections: [workflowProjection],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: null,
			truncated: false,
		})
	const env = {
		APP_DB: db,
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportRuns }),
		},
	} as unknown as Env

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
		pageSize: 1,
	})
	expect(first.items).toEqual([{ run, logs: [] }])
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('invocation-ledger:')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
		pageSize: 1,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([{ workflowProjection }])
	expect(second.truncated).toBe(false)
	expect(exportRuns).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			pageSize: 1,
			startAfter: 'invocation-ledger:',
		}),
	)
})

test('storage_runners count matches ids enumerable by discovery paging', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
		INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (
			'job-1', 'user-aaa', 'Job', 'src-job-1', 'job:job-1', '{}', 'UTC',
			'{}', '2026-07-05', '2026-07-05', '2026-07-05'
		);
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-aaa', 'exec:adhoc', 'execute', '2026-07-05', '2026-07-05'
		);
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-1', 'user-aaa', 'Pkg', 'pkg', '', '[]',
			'src-1', 1, 0, 1, '2026-07-05', '2026-07-05'
		);
	`)

	const env = {
		APP_DB: db,
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listStorageIds: async () => [
					'exec:adhoc',
					'exec:runlog-only',
					'job:job-1',
				],
			}),
		},
	} as unknown as Env
	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	const expectedCount = manifest.sections.storage_runners?.count
	expect(expectedCount).toBeGreaterThan(0)

	const seen = new Set<string>()
	let startAfter: string | undefined
	for (;;) {
		const page = await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'durable_object_summaries',
			kind: 'storage_runner',
			pageSize: 2,
			startAfter,
		})
		for (const item of page.items as Array<{ storageId: string }>) {
			seen.add(item.storageId)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(seen.size).toBe(expectedCount)
	expect(seen.has('exec:runlog-only')).toBe(true)
})

test('storage_runner section exports a RunLog-only storage id', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)

	const exportStorage = vi.fn(async () => ({
		entries: [{ key: 'runlog', value: { ok: true } }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 100,
		estimatedBytes: 8,
	}))
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportStorage }),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listStorageIds: async () => ['exec:runlog-export-only'],
			}),
		},
	} as unknown as Env

	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(manifest.sections.storage_runners?.count).toBe(1)

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'storage_runner',
		storageId: 'exec:runlog-export-only',
	})
	expect(section.items).toEqual([{ key: 'runlog', value: { ok: true } }])
	expect(exportStorage).toHaveBeenCalledTimes(1)
})

test('storage_runner section reads do not load manifests for D1-known rows', async () => {
	const loadManifest = vi.spyOn(
		await import('#worker/package-registry/source.ts'),
		'loadPackageManifestBySourceId',
	)
	loadManifest.mockRejectedValue(new Error('manifest should not be loaded'))
	try {
		const { sqlite, db } = createMigratedDb()
		sqlite.exec(`
			INSERT INTO users (
				id, username, email, password_hash, created_at, updated_at,
				email_verified_at, stable_user_id
			)
			VALUES (
				1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
				'2026-07-05', '2026-07-05', 'user-aaa'
			);
			INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (
				'user-aaa', 'exec:section-only', 'execute',
				'2026-07-05', '2026-07-05'
			);
		`)

		const exportStorage = vi.fn(async () => ({
			entries: [],
			truncated: false,
			nextStartAfter: null,
			pageSize: 100,
			estimatedBytes: 0,
		}))
		const env = {
			APP_DB: db,
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ exportStorage }),
			},
		} as unknown as Env

		await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'storage_runner',
			storageId: 'exec:section-only',
		})
		expect(loadManifest).not.toHaveBeenCalled()
	} finally {
		loadManifest.mockRestore()
	}
})
