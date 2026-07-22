import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	emailRawMimeKey,
	emailRawMimeKeysForDelete,
	isEmailRawMimeKeyReferenced,
	isOwnedEmailRawMimeKey,
} from './repo.ts'
import { createD1FromSqlite } from '#worker/test-support/email-raw-mime-offload-fixtures.ts'

function createRawMimeKeyDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			raw_mime_key TEXT
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('isOwnedEmailRawMimeKey accepts only email-raw:v1:{userId}/... keys', () => {
	expect(
		isOwnedEmailRawMimeKey('user-1', emailRawMimeKey('user-1', 'msg-1')),
	).toBe(true)
	expect(
		isOwnedEmailRawMimeKey('user-1', 'email-raw:v1:user-1/extra/path'),
	).toBe(true)
	expect(
		isOwnedEmailRawMimeKey('user-1', emailRawMimeKey('user-2', 'msg-1')),
	).toBe(false)
	expect(isOwnedEmailRawMimeKey('user-1', 'email-raw:v1:user-1/')).toBe(false)
	expect(
		isOwnedEmailRawMimeKey('user-1', 'email-raw:legacy/user-1/msg-1'),
	).toBe(false)
	expect(isOwnedEmailRawMimeKey('user-1', 'email-raw:v1:user-10/msg-1')).toBe(
		false,
	)
	expect(isOwnedEmailRawMimeKey('', emailRawMimeKey('user-1', 'msg-1'))).toBe(
		false,
	)
})

test('emailRawMimeKeysForDelete includes owned unreferenced divergent keys and rejects cross-user', async () => {
	const { db } = createRawMimeKeyDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-1')
	const ownedDivergent = emailRawMimeKey('user-1', 'legacy-msg')
	const foreign = emailRawMimeKey('user-2', 'msg-1')

	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-1',
			storedRawMimeKey: ownedDivergent,
		}),
	).resolves.toEqual([deterministic, ownedDivergent])
	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-1',
			storedRawMimeKey: foreign,
		}),
	).resolves.toEqual([deterministic])
	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-1',
			storedRawMimeKey: 'email-raw:legacy/user-1/msg-1',
		}),
	).resolves.toEqual([deterministic])
	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-1',
			storedRawMimeKey: deterministic,
		}),
	).resolves.toEqual([deterministic])
})

test('emailRawMimeKeysForDelete omits divergent key still referenced by another row', async () => {
	const { sqlite, db } = createRawMimeKeyDb()
	const deterministic = emailRawMimeKey('user-1', 'msg-a')
	const shared = emailRawMimeKey('user-1', 'shared')
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime_key) VALUES (?, ?, ?)`,
		)
		.run('msg-a', 'user-1', shared)
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime_key) VALUES (?, ?, ?)`,
		)
		.run('msg-b', 'user-1', shared)

	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-a',
			storedRawMimeKey: shared,
		}),
	).resolves.toEqual([deterministic])

	// Sibling being deleted in the same batch is excluded from the check.
	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-a',
			storedRawMimeKey: shared,
			alsoExcludingMessageIds: ['msg-a', 'msg-b'],
		}),
	).resolves.toEqual([deterministic, shared])

	sqlite.prepare(`DELETE FROM email_messages WHERE id = ?`).run('msg-b')
	await expect(
		emailRawMimeKeysForDelete({
			db,
			userId: 'user-1',
			messageId: 'msg-a',
			storedRawMimeKey: shared,
		}),
	).resolves.toEqual([deterministic, shared])
})

test('isEmailRawMimeKeyReferenced detects other-row references', async () => {
	const { sqlite, db } = createRawMimeKeyDb()
	const shared = emailRawMimeKey('user-1', 'shared')
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime_key) VALUES (?, ?, ?)`,
		)
		.run('msg-a', 'user-1', shared)
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime_key) VALUES (?, ?, ?)`,
		)
		.run('msg-b', 'user-1', shared)

	await expect(
		isEmailRawMimeKeyReferenced({
			db,
			objectKey: shared,
			excludeMessageIds: ['msg-a'],
		}),
	).resolves.toBe(true)
	sqlite.prepare(`DELETE FROM email_messages WHERE id = ?`).run('msg-b')
	await expect(
		isEmailRawMimeKeyReferenced({
			db,
			objectKey: shared,
			excludeMessageIds: ['msg-a'],
		}),
	).resolves.toBe(false)
})
