import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	claimEmailMessagesForDeletion,
	deleteEmailMessageById,
	emailRawMimeKey,
} from '#worker/email/repo.ts'
import {
	countInlineRawMimeResiduals,
	emailRawMimeOffloadPageSize,
	emailRawMimeOrphanDeleteAttempts,
	handleEmailRawMimeOffloadRequest,
	offloadInlineEmailRawMime,
} from './email-raw-mime-offload-maintenance.ts'

function createD1FromSqlite(db: DatabaseSync) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
	} as unknown as D1Database
}

function emptyCleanup() {
	return { scanned: 0, deleted: 0, failed: 0 }
}

function createEmailMessagesDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			raw_mime TEXT,
			raw_mime_key TEXT,
			raw_mime_offload_blocked INTEGER NOT NULL DEFAULT 0
				CHECK (raw_mime_offload_blocked IN (0, 1)),
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			storage_key TEXT,
			content_type TEXT NOT NULL DEFAULT 'text/plain',
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL DEFAULT 'raw-mime',
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_raw_mime_cleanup_queue (
			object_key TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX idx_email_messages_raw_mime_offload_unblocked
		ON email_messages (id)
		WHERE raw_mime IS NOT NULL AND raw_mime_offload_blocked = 0;
		CREATE INDEX idx_email_raw_mime_cleanup_queue_user_id
		ON email_raw_mime_cleanup_queue (user_id);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function readCleanupQueue(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT object_key, user_id, message_id, attempt_count, last_error
			FROM email_raw_mime_cleanup_queue
			ORDER BY object_key`,
		)
		.all() as Array<{
		object_key: string
		user_id: string
		message_id: string
		attempt_count: number
		last_error: string | null
	}>
}

function insertMessage(
	sqlite: DatabaseSync,
	input: {
		id: string
		userId: string
		rawMime?: string | null
		rawMimeKey?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime, raw_mime_key)
			VALUES (?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.rawMime ?? null,
			input.rawMimeKey ?? null,
		)
}

function readMessage(sqlite: DatabaseSync, id: string) {
	return sqlite
		.prepare(
			`SELECT id, user_id, raw_mime, raw_mime_key, raw_mime_offload_blocked
			FROM email_messages
			WHERE id = ?`,
		)
		.get(id) as {
		id: string
		user_id: string
		raw_mime: string | null
		raw_mime_key: string | null
		raw_mime_offload_blocked: number
	} | null
}

function createMemoryBlobs(options?: {
	failPutForKeys?: ReadonlySet<string>
	deleteImpl?: (key: string, store: Map<string, string>) => Promise<void>
}) {
	const store = new Map<string, string>()
	const put = vi.fn(async (key: string, value: string | ArrayBuffer | Blob) => {
		if (options?.failPutForKeys?.has(key)) {
			throw new Error(`r2-put-failed:${key}`)
		}
		const text =
			typeof value === 'string'
				? value
				: value instanceof Blob
					? await value.text()
					: new TextDecoder().decode(value)
		store.set(key, text)
	})
	const del = vi.fn(async (key: string) => {
		if (options?.deleteImpl) {
			await options.deleteImpl(key, store)
			return
		}
		store.delete(key)
	})
	return {
		store,
		blobs: { put, delete: del } as unknown as R2Bucket,
		put,
		del,
	}
}

function createCasMissDb(
	sqlite: DatabaseSync,
	baseDb: D1Database,
	behavior: (id: string, key: string, userId: string) => 'delete-row' | 'miss',
) {
	return {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const key = String(params[0])
						const id = String(params[2])
						const userId = String(params[3])
						return {
							async run() {
								const action = behavior(id, key, userId)
								if (action === 'delete-row') {
									sqlite
										.prepare(`DELETE FROM email_messages WHERE id = ?`)
										.run(id)
									return { meta: { changes: 0 } }
								}
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database
}

function createOffloadRequest(
	input: { method?: string; authorization?: string } = {},
) {
	return new Request(
		'https://kody.example.com/__maintenance/offload-email-raw-mime',
		{
			method: input.method ?? 'POST',
			headers:
				input.authorization === undefined
					? undefined
					: { Authorization: input.authorization },
		},
	)
}

test('email raw MIME offload auth, one-batch continuation, and deploy response semantics', async () => {
	const { sqlite, db } = createEmailMessagesDb()
	for (let index = 0; index < 12; index += 1) {
		insertMessage(sqlite, {
			id: `msg-${String(index).padStart(2, '0')}`,
			userId: 'user-1',
			rawMime: `mime-${index}`,
		})
	}
	const { store, blobs } = createMemoryBlobs()
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
		APP_DB: db,
		EMAIL_BLOBS: blobs,
	} as Env

	const methodResponse = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ method: 'GET', authorization: 'Bearer secret' }),
		env,
	)
	expect(methodResponse.status).toBe(405)

	const unauthorized = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer wrong' }),
		env,
	)
	expect(unauthorized.status).toBe(401)

	expect(emailRawMimeOffloadPageSize).toBe(10)
	const first = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer secret' }),
		env,
	)
	expect(first.status).toBe(200)
	await expect(first.json()).resolves.toEqual({
		ok: true,
		scanned: 10,
		offloaded: 10,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 2,
		remainingOffloadableInline: 2,
		remainingBlockedInline: 0,
		complete: false,
	})
	expect(store.size).toBe(10)

	const second = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer secret' }),
		env,
	)
	expect(second.status).toBe(200)
	await expect(second.json()).resolves.toEqual({
		ok: true,
		scanned: 2,
		offloaded: 2,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: true,
	})
	await expect(countInlineRawMimeResiduals(db)).resolves.toEqual({
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
	})
	expect(store.get(emailRawMimeKey('user-1', 'msg-00'))).toBe('mime-0')
	expect(readMessage(sqlite, 'msg-11')).toMatchObject({
		raw_mime: null,
		raw_mime_key: emailRawMimeKey('user-1', 'msg-11'),
	})
})

test('email raw MIME offload CAS miss cleans orphan when row is gone and fails when inline remains', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-gone',
		userId: 'user-1',
		rawMime: 'gone-bytes',
	})
	insertMessage(sqlite, {
		id: 'msg-stuck',
		userId: 'user-1',
		rawMime: 'stuck-bytes',
	})

	const { store, blobs, del } = createMemoryBlobs()
	let updateCalls = 0
	const raceDb = {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const key = String(params[0])
						const id = String(params[2])
						return {
							async run() {
								updateCalls += 1
								if (id === 'msg-gone') {
									sqlite
										.prepare(`DELETE FROM email_messages WHERE id = ?`)
										.run(id)
									return { meta: { changes: 0 } }
								}
								if (id === 'msg-stuck') {
									// Simulate a lost update: put already landed, CAS misses,
									// and the row still shows inline bytes on reread.
									return { meta: { changes: 0 } }
								}
								return baseDb
									.prepare(query)
									.bind(...params)
									.run()
							},
							key,
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database

	const result = await offloadInlineEmailRawMime({ db: raceDb, blobs })
	expect(updateCalls).toBe(2)
	expect(result).toEqual({
		scanned: 2,
		offloaded: 0,
		failed: 1,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 1,
		remainingOffloadableInline: 1,
		remainingBlockedInline: 0,
		complete: false,
	})
	expect(readMessage(sqlite, 'msg-gone')).toBeFalsy()
	expect(store.has(emailRawMimeKey('user-1', 'msg-gone'))).toBe(false)
	expect(del).toHaveBeenCalledWith(emailRawMimeKey('user-1', 'msg-gone'))
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(readMessage(sqlite, 'msg-stuck')).toMatchObject({
		raw_mime: 'stuck-bytes',
		raw_mime_key: null,
	})
	expect(store.get(emailRawMimeKey('user-1', 'msg-stuck'))).toBe('stuck-bytes')
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-row-failed',
		'msg-stuck',
		expect.any(Error),
	)

	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
		APP_DB: raceDb,
		EMAIL_BLOBS: blobs,
	} as Env
	const response = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer secret' }),
		env,
	)
	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		failed: 1,
		remainingBlobCleanup: 0,
		complete: false,
	})
})

test('email raw MIME offload repairs dual-state and treats concurrent clear as success', async () => {
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	const dualKey = emailRawMimeKey('user-1', 'msg-dual')
	insertMessage(sqlite, {
		id: 'msg-dual',
		userId: 'user-1',
		rawMime: 'authoritative-inline',
		rawMimeKey: dualKey,
	})
	insertMessage(sqlite, {
		id: 'msg-concurrent',
		userId: 'user-2',
		rawMime: 'will-clear-elsewhere',
	})

	const { store, blobs } = createMemoryBlobs()
	store.set(dualKey, 'stale-blob')

	const raceDb = {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const key = String(params[0])
						const id = String(params[2])
						const userId = String(params[3])
						return {
							async run() {
								if (id === 'msg-concurrent') {
									sqlite
										.prepare(
											`UPDATE email_messages
											SET raw_mime = NULL, raw_mime_key = ?, updated_at = ?
											WHERE id = ? AND user_id = ?`,
										)
										.run(key, '2026-01-02T00:00:00.000Z', id, userId)
									return { meta: { changes: 0 } }
								}
								return baseDb
									.prepare(query)
									.bind(...params)
									.run()
							},
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database

	const result = await offloadInlineEmailRawMime({ db: raceDb, blobs })
	expect(result).toEqual({
		scanned: 2,
		offloaded: 2,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: true,
	})
	expect(store.get(dualKey)).toBe('authoritative-inline')
	expect(readMessage(sqlite, 'msg-dual')).toMatchObject({
		raw_mime: null,
		raw_mime_key: dualKey,
	})
	expect(readMessage(sqlite, 'msg-concurrent')).toMatchObject({
		raw_mime: null,
		raw_mime_key: emailRawMimeKey('user-2', 'msg-concurrent'),
	})
})

test('email raw MIME offload leaves inline intact on R2 or D1 failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-r2',
		userId: 'user-1',
		rawMime: 'r2-fail-bytes',
	})
	insertMessage(sqlite, {
		id: 'msg-d1',
		userId: 'user-1',
		rawMime: 'd1-fail-bytes',
	})

	const failKey = emailRawMimeKey('user-1', 'msg-r2')
	const { store, blobs } = createMemoryBlobs({
		failPutForKeys: new Set([failKey]),
	})
	const failingDb = {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const id = String(params[2])
						return {
							async run() {
								if (id === 'msg-d1') throw new Error('d1-update-failed')
								return baseDb
									.prepare(query)
									.bind(...params)
									.run()
							},
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database

	const result = await offloadInlineEmailRawMime({
		db: failingDb,
		blobs,
	})
	expect(result).toEqual({
		scanned: 2,
		offloaded: 0,
		failed: 2,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 2,
		remainingOffloadableInline: 2,
		remainingBlockedInline: 0,
		complete: false,
	})
	expect(store.has(failKey)).toBe(false)
	expect(store.get(emailRawMimeKey('user-1', 'msg-d1'))).toBe('d1-fail-bytes')
	expect(readMessage(sqlite, 'msg-r2')).toMatchObject({
		raw_mime: 'r2-fail-bytes',
		raw_mime_key: null,
	})
	expect(readMessage(sqlite, 'msg-d1')).toMatchObject({
		raw_mime: 'd1-fail-bytes',
		raw_mime_key: null,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-row-failed',
		'msg-r2',
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-row-failed',
		'msg-d1',
		expect.any(Error),
	)
})

test('email raw MIME offload retries transient orphan deletes after CAS miss', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-retry',
		userId: 'user-1',
		rawMime: 'retry-bytes',
	})
	const orphanKey = emailRawMimeKey('user-1', 'msg-retry')
	let deleteAttempts = 0
	const { store, blobs, del } = createMemoryBlobs({
		deleteImpl: async (key, memory) => {
			deleteAttempts += 1
			if (deleteAttempts < emailRawMimeOrphanDeleteAttempts) {
				throw new Error(`transient-orphan-delete:${key}`)
			}
			memory.delete(key)
		},
	})
	const raceDb = createCasMissDb(sqlite, baseDb, () => 'delete-row')

	const result = await offloadInlineEmailRawMime({ db: raceDb, blobs })
	expect(result).toEqual({
		scanned: 1,
		offloaded: 0,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: true,
	})
	expect(deleteAttempts).toBe(emailRawMimeOrphanDeleteAttempts)
	expect(del).toHaveBeenCalledTimes(emailRawMimeOrphanDeleteAttempts)
	expect(store.has(orphanKey)).toBe(false)
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-orphan-delete-failed',
		'msg-retry',
		1,
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-orphan-delete-failed',
		'msg-retry',
		2,
		expect.any(Error),
	)
})

test('email raw MIME offload fails when orphan delete stays broken after retries', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	const putKey = emailRawMimeKey('user-1', 'msg-orphan')
	const keptKey = 'email-raw:legacy/user-1/msg-orphan'
	insertMessage(sqlite, {
		id: 'msg-orphan',
		userId: 'user-1',
		rawMime: 'orphan-bytes',
		rawMimeKey: keptKey,
	})
	const { store, blobs, del } = createMemoryBlobs({
		deleteImpl: async () => {
			throw new Error('permanent-orphan-delete')
		},
	})
	// CAS miss with inline already cleared to a divergent stored key: our put
	// must be cleaned up, and permanent delete failure must fail the row.
	const raceDb = {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const id = String(params[2])
						const userId = String(params[3])
						return {
							async run() {
								sqlite
									.prepare(
										`UPDATE email_messages
										SET raw_mime = NULL, raw_mime_key = ?, updated_at = ?
										WHERE id = ? AND user_id = ?`,
									)
									.run(keptKey, '2026-01-02T00:00:00.000Z', id, userId)
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database

	expect(emailRawMimeOrphanDeleteAttempts).toBe(3)
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
		APP_DB: raceDb,
		EMAIL_BLOBS: blobs,
	} as Env
	const response = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer secret' }),
		env,
	)
	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Email raw MIME offload failed for 1 row(s)',
		scanned: 1,
		offloaded: 0,
		failed: 1,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 1,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: false,
	})
	expect(del).toHaveBeenCalledTimes(emailRawMimeOrphanDeleteAttempts)
	expect(del).toHaveBeenCalledWith(putKey)
	expect(store.get(putKey)).toBe('orphan-bytes')
	expect(readCleanupQueue(sqlite)).toEqual([
		{
			object_key: putKey,
			user_id: 'user-1',
			message_id: 'msg-orphan',
			attempt_count: 1,
			last_error: 'permanent-orphan-delete',
		},
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-orphan-delete-failed',
		'msg-orphan',
		emailRawMimeOrphanDeleteAttempts,
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-row-failed',
		'msg-orphan',
		expect.any(Error),
	)
})

test('interleaving: delete claim between offload select and put cleans put and skips', async () => {
	const { sqlite, db } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-race-claim',
		userId: 'user-1',
		rawMime: 'race-bytes',
	})
	const key = emailRawMimeKey('user-1', 'msg-race-claim')
	const { store, blobs, put, del } = createMemoryBlobs()
	put.mockImplementation(async (putKey: string, value: string) => {
		await claimEmailMessagesForDeletion({
			db,
			userId: 'user-1',
			messageIds: ['msg-race-claim'],
		})
		store.set(putKey, value)
	})

	const result = await offloadInlineEmailRawMime({ db, blobs })
	expect(result).toEqual({
		scanned: 1,
		offloaded: 0,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 1,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 1,
		complete: true,
	})
	expect(store.has(key)).toBe(false)
	expect(del).toHaveBeenCalledWith(key)
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(readMessage(sqlite, 'msg-race-claim')).toMatchObject({
		raw_mime: 'race-bytes',
		raw_mime_key: null,
		raw_mime_offload_blocked: 1,
	})
})

test('interleaving: offload clear before delete claim leaves no orphan', async () => {
	const { sqlite, db } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-clear-first',
		userId: 'user-1',
		rawMime: 'clear-first-bytes',
	})
	const key = emailRawMimeKey('user-1', 'msg-clear-first')
	const { store, blobs } = createMemoryBlobs()

	const offload = await offloadInlineEmailRawMime({ db, blobs })
	expect(offload).toEqual({
		scanned: 1,
		offloaded: 1,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: true,
	})
	expect(store.get(key)).toBe('clear-first-bytes')
	expect(readMessage(sqlite, 'msg-clear-first')).toMatchObject({
		raw_mime: null,
		raw_mime_key: key,
		raw_mime_offload_blocked: 0,
	})

	await deleteEmailMessageById({
		db,
		blobs,
		messageId: 'msg-clear-first',
	})
	expect(readMessage(sqlite, 'msg-clear-first')).toBeFalsy()
	expect(store.has(key)).toBe(false)
})

test('interleaving: retention claim before put excludes row from offload batch', async () => {
	const { sqlite, db } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-retention-claimed',
		userId: 'user-1',
		rawMime: 'claimed-bytes',
	})
	insertMessage(sqlite, {
		id: 'msg-still-open',
		userId: 'user-1',
		rawMime: 'open-bytes',
	})

	const claimed = await claimEmailMessagesForDeletion({
		db,
		userId: 'user-1',
		messageIds: ['msg-retention-claimed'],
	})
	expect(claimed).toBe(1)
	// Cross-user claim must not touch the owner's row.
	expect(
		await claimEmailMessagesForDeletion({
			db,
			userId: 'user-other',
			messageIds: ['msg-still-open'],
		}),
	).toBe(0)

	const { store, blobs } = createMemoryBlobs()
	const result = await offloadInlineEmailRawMime({ db, blobs })
	expect(result).toEqual({
		scanned: 1,
		offloaded: 1,
		failed: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 0,
		remainingInline: 1,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 1,
		complete: true,
	})
	expect(store.has(emailRawMimeKey('user-1', 'msg-retention-claimed'))).toBe(
		false,
	)
	expect(store.get(emailRawMimeKey('user-1', 'msg-still-open'))).toBe(
		'open-bytes',
	)
	expect(readMessage(sqlite, 'msg-retention-claimed')).toMatchObject({
		raw_mime: 'claimed-bytes',
		raw_mime_offload_blocked: 1,
	})
	expect(readMessage(sqlite, 'msg-still-open')).toMatchObject({
		raw_mime: null,
		raw_mime_offload_blocked: 0,
	})
})

test('interleaving: blocked cleanup failure fails offload rather than reporting success', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-blocked-cleanup',
		userId: 'user-1',
		rawMime: 'blocked-bytes',
	})
	const key = emailRawMimeKey('user-1', 'msg-blocked-cleanup')
	const { store, blobs, put } = createMemoryBlobs({
		deleteImpl: async () => {
			throw new Error('blocked-orphan-delete-permanent')
		},
	})
	put.mockImplementation(async (putKey: string, value: string) => {
		await claimEmailMessagesForDeletion({
			db,
			userId: 'user-1',
			messageIds: ['msg-blocked-cleanup'],
		})
		store.set(putKey, value)
	})

	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
		APP_DB: db,
		EMAIL_BLOBS: blobs,
	} as Env
	const response = await handleEmailRawMimeOffloadRequest(
		createOffloadRequest({ authorization: 'Bearer secret' }),
		env,
	)
	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		failed: 1,
		offloaded: 0,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 1,
		remainingInline: 1,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 1,
		complete: false,
	})
	expect(store.get(key)).toBe('blocked-bytes')
	expect(readCleanupQueue(sqlite)).toEqual([
		{
			object_key: key,
			user_id: 'user-1',
			message_id: 'msg-blocked-cleanup',
			attempt_count: 1,
			last_error: 'blocked-orphan-delete-permanent',
		},
	])
})

test('sticky cleanup queue: first orphan delete failure leaves queue; second request drains it before complete', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db: baseDb } = createEmailMessagesDb()
	insertMessage(sqlite, {
		id: 'msg-sticky',
		userId: 'user-1',
		rawMime: 'sticky-bytes',
	})
	const orphanKey = emailRawMimeKey('user-1', 'msg-sticky')
	let allowDelete = false
	const { store, blobs, del } = createMemoryBlobs({
		deleteImpl: async (key, memory) => {
			if (!allowDelete) {
				throw new Error(`sticky-orphan-delete:${key}`)
			}
			memory.delete(key)
		},
	})
	const raceDb = createCasMissDb(sqlite, baseDb, () => 'delete-row')

	const first = await offloadInlineEmailRawMime({ db: raceDb, blobs })
	expect(first).toEqual({
		scanned: 1,
		offloaded: 0,
		failed: 1,
		cleanup: emptyCleanup(),
		remainingBlobCleanup: 1,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: false,
	})
	expect(store.get(orphanKey)).toBe('sticky-bytes')
	expect(readCleanupQueue(sqlite)).toEqual([
		{
			object_key: orphanKey,
			user_id: 'user-1',
			message_id: 'msg-sticky',
			attempt_count: 1,
			last_error: `sticky-orphan-delete:${orphanKey}`,
		},
	])
	expect(del).toHaveBeenCalledTimes(emailRawMimeOrphanDeleteAttempts)

	// Cross-user queue mutation must not clear another user's tombstone.
	sqlite
		.prepare(
			`DELETE FROM email_raw_mime_cleanup_queue
			WHERE object_key = ? AND user_id = ?`,
		)
		.run(orphanKey, 'user-other')
	expect(readCleanupQueue(sqlite)).toHaveLength(1)

	allowDelete = true
	const deleteCallsBeforeRetry = del.mock.calls.length
	const second = await offloadInlineEmailRawMime({ db: raceDb, blobs })
	expect(second).toEqual({
		scanned: 0,
		offloaded: 0,
		failed: 0,
		cleanup: { scanned: 1, deleted: 1, failed: 0 },
		remainingBlobCleanup: 0,
		remainingInline: 0,
		remainingOffloadableInline: 0,
		remainingBlockedInline: 0,
		complete: true,
	})
	expect(del.mock.calls.length).toBeGreaterThan(deleteCallsBeforeRetry)
	expect(store.has(orphanKey)).toBe(false)
	expect(readCleanupQueue(sqlite)).toEqual([])
})
