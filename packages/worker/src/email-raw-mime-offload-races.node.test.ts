import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	claimEmailMessagesForDeletion,
	deleteEmailMessageById,
	emailRawMimeKey,
} from '#worker/email/repo.ts'
import {
	createCasMissDb,
	createEmailMessagesDb,
	createMemoryBlobs,
	createOffloadRequest,
	emptyCleanup,
	insertMessage,
	readCleanupQueue,
	readMessage,
} from '#worker/test-support/email-raw-mime-offload-fixtures.ts'
import {
	emailRawMimeOrphanDeleteAttempts,
	handleEmailRawMimeOffloadRequest,
	offloadInlineEmailRawMime,
} from './email-raw-mime-offload-maintenance.ts'

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

test('successful offload cleans owned divergent prior raw_mime_key via sticky queue', async () => {
	const { sqlite, db } = createEmailMessagesDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-divergent')
	const prior = emailRawMimeKey('user-1', 'legacy-divergent')
	insertMessage(sqlite, {
		id: 'msg-divergent',
		userId: 'user-1',
		rawMime: 'fresh-inline',
		rawMimeKey: prior,
	})
	const { store, blobs, del } = createMemoryBlobs()
	store.set(prior, 'stale-prior-bytes')

	const result = await offloadInlineEmailRawMime({ db, blobs })
	expect(result).toEqual({
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
	expect(store.get(deterministic)).toBe('fresh-inline')
	expect(store.has(prior)).toBe(false)
	expect(del).toHaveBeenCalledWith(prior)
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(readMessage(sqlite, 'msg-divergent')).toMatchObject({
		raw_mime: null,
		raw_mime_key: deterministic,
	})
})

test('divergent prior cleanup failure is sticky across requests', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createEmailMessagesDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-prior-fail')
	const prior = emailRawMimeKey('user-1', 'legacy-prior-fail')
	insertMessage(sqlite, {
		id: 'msg-prior-fail',
		userId: 'user-1',
		rawMime: 'inline-bytes',
		rawMimeKey: prior,
	})
	let allowDelete = false
	const { store, blobs } = createMemoryBlobs({
		deleteImpl: async (key, memory) => {
			if (key === prior && !allowDelete) {
				throw new Error(`prior-delete-failed:${key}`)
			}
			memory.delete(key)
		},
	})
	store.set(prior, 'stale-prior')

	const first = await offloadInlineEmailRawMime({ db, blobs })
	expect(first).toMatchObject({
		scanned: 1,
		offloaded: 0,
		failed: 1,
		remainingBlobCleanup: 1,
		remainingOffloadableInline: 0,
		complete: false,
	})
	expect(store.get(deterministic)).toBe('inline-bytes')
	expect(store.get(prior)).toBe('stale-prior')
	expect(readCleanupQueue(sqlite)).toEqual([
		{
			object_key: prior,
			user_id: 'user-1',
			message_id: 'msg-prior-fail',
			attempt_count: 1,
			last_error: `prior-delete-failed:${prior}`,
		},
	])
	expect(readMessage(sqlite, 'msg-prior-fail')).toMatchObject({
		raw_mime: null,
		raw_mime_key: deterministic,
	})

	allowDelete = true
	const second = await offloadInlineEmailRawMime({ db, blobs })
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
	expect(store.has(prior)).toBe(false)
	expect(readCleanupQueue(sqlite)).toEqual([])
})

test('cross-user divergent prior key is rejected and not deleted', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createEmailMessagesDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-cross')
	const foreign = emailRawMimeKey('user-2', 'msg-foreign')
	insertMessage(sqlite, {
		id: 'msg-cross',
		userId: 'user-1',
		rawMime: 'cross-inline',
		rawMimeKey: foreign,
	})
	const { store, blobs, del } = createMemoryBlobs()
	store.set(foreign, 'foreign-bytes')

	const result = await offloadInlineEmailRawMime({ db, blobs })
	expect(result).toEqual({
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
	expect(store.get(deterministic)).toBe('cross-inline')
	expect(store.get(foreign)).toBe('foreign-bytes')
	expect(del).not.toHaveBeenCalledWith(foreign)
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-key-ownership-rejected',
		'msg-cross',
		'user-1',
		foreign,
	)
})

test('divergent prior key referenced by another row is preserved', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createEmailMessagesDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-shared-offload')
	const shared = emailRawMimeKey('user-1', 'shared-blob')
	insertMessage(sqlite, {
		id: 'msg-shared-offload',
		userId: 'user-1',
		rawMime: 'offload-me',
		rawMimeKey: shared,
	})
	insertMessage(sqlite, {
		id: 'msg-still-points',
		userId: 'user-1',
		rawMime: null,
		rawMimeKey: shared,
	})
	const { store, blobs, del } = createMemoryBlobs()
	store.set(shared, 'shared-bytes')

	const result = await offloadInlineEmailRawMime({ db, blobs })
	expect(result).toEqual({
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
	expect(store.get(deterministic)).toBe('offload-me')
	expect(store.get(shared)).toBe('shared-bytes')
	expect(del).not.toHaveBeenCalledWith(shared)
	expect(readCleanupQueue(sqlite)).toEqual([])
	expect(readMessage(sqlite, 'msg-still-points')).toMatchObject({
		raw_mime_key: shared,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-raw-mime-offload-key-still-referenced',
		'msg-shared-offload',
		shared,
	)
})

test('cleanup queue drains lower attempt_count rows before sticky failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createEmailMessagesDb()
	const stickyKey = emailRawMimeKey('user-1', 'sticky-head')
	const freshKey = emailRawMimeKey('user-1', 'fresh-tail')
	sqlite
		.prepare(
			`INSERT INTO email_raw_mime_cleanup_queue (
				object_key, user_id, message_id, attempt_count, last_error, created_at, updated_at
			) VALUES
				(?, 'user-1', 'sticky-head', 5, 'old-failure', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
				(?, 'user-1', 'fresh-tail', 0, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.run(stickyKey, freshKey)
	const { store, blobs } = createMemoryBlobs({
		deleteImpl: async (key, memory) => {
			if (key === stickyKey) {
				throw new Error(`sticky-still-broken:${key}`)
			}
			memory.delete(key)
		},
	})
	store.set(stickyKey, 'sticky')
	store.set(freshKey, 'fresh')

	const result = await offloadInlineEmailRawMime({
		db,
		blobs,
		pageSize: 1,
	})
	expect(result.cleanup).toEqual({ scanned: 1, deleted: 1, failed: 0 })
	expect(store.has(freshKey)).toBe(false)
	expect(store.get(stickyKey)).toBe('sticky')
	expect(readCleanupQueue(sqlite)).toEqual([
		expect.objectContaining({
			object_key: stickyKey,
			attempt_count: 5,
		}),
	])
	expect(result.remainingBlobCleanup).toBe(1)
	expect(result.complete).toBe(false)
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
