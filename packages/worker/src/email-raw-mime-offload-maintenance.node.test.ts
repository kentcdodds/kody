import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	createEmailMessagesDb,
	createMemoryBlobs,
	createOffloadRequest,
	emptyCleanup,
	insertMessage,
	readMessage,
} from '#worker/test-support/email-raw-mime-offload-fixtures.ts'
import { emailRawMimeKey } from '#worker/email/repo.ts'
import {
	countInlineRawMimeResiduals,
	emailRawMimeOffloadPageSize,
	handleEmailRawMimeOffloadRequest,
	offloadInlineEmailRawMime,
} from './email-raw-mime-offload-maintenance.ts'

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
