import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const dropEmailRawMimeInlineMigration = '0077-drop-email-raw-mime-inline.sql'

const durableEmailMessageIndexes = [
	'idx_email_messages_created_at',
	'idx_email_messages_inbox_created_at',
	'idx_email_messages_message_id_header',
	'idx_email_messages_provider_message_id',
	'idx_email_messages_thread_created_at',
	'idx_email_messages_user_created_at',
] as const

/** D1 wraps each migration file in a transaction; mirror that in rollback tests. */
function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

function applyMigrationsBeforeDrop(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(file) => file.endsWith('.sql') && file < dropEmailRawMimeInlineMigration,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function emailMessagesColumnNames(db: DatabaseSync) {
	return (
		db.prepare(`PRAGMA table_info(email_messages)`).all() as Array<{
			name: string
		}>
	).map((column) => column.name)
}

function emailMessagesIndexes(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index'
				   AND tbl_name = 'email_messages'
				   AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
}

function seedCleanEmailMessage(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', 'stable-alice');

		INSERT INTO email_messages (
			id, direction, user_id, from_address, raw_mime_key, raw_size,
			processing_status, created_at, updated_at
		) VALUES (
			'message-1', 'inbound', 'stable-alice', 'sender@example.com',
			'email-raw:v1:stable-alice/message-1', 128, 'stored',
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
		);

		INSERT INTO email_attachments (
			id, message_id, content_type, storage_kind, created_at
		) VALUES (
			'attachment-1', 'message-1', 'text/plain', 'raw-mime',
			'2026-07-01T00:00:00.000Z'
		);

		INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, created_at
		) VALUES (
			'event-1', 'message-1', 'stable-alice', 'received',
			'2026-07-01T00:00:00.000Z'
		);
	`)
}

test('drop email raw mime inline migration removes transitional schema and preserves references', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeDrop(db)
	seedCleanEmailMessage(db)

	expect(emailMessagesColumnNames(db)).toEqual(
		expect.arrayContaining([
			'raw_mime',
			'raw_mime_key',
			'raw_mime_offload_blocked',
		]),
	)
	expect(emailMessagesIndexes(db)).toContain(
		'idx_email_messages_raw_mime_offload_unblocked',
	)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name = 'email_raw_mime_cleanup_queue'`,
			)
			.get(),
	).toEqual({ name: 'email_raw_mime_cleanup_queue' })

	applyMigrationLikeD1(db, dropEmailRawMimeInlineMigration)

	expect(emailMessagesColumnNames(db)).toEqual(
		expect.arrayContaining(['raw_mime_key']),
	)
	expect(emailMessagesColumnNames(db)).not.toContain('raw_mime')
	expect(emailMessagesColumnNames(db)).not.toContain('raw_mime_offload_blocked')
	expect(emailMessagesIndexes(db)).not.toContain(
		'idx_email_messages_raw_mime_offload_unblocked',
	)
	expect(emailMessagesIndexes(db)).toEqual([...durableEmailMessageIndexes])
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name = 'email_raw_mime_cleanup_queue'`,
			)
			.all(),
	).toEqual([])
	expect(
		db
			.prepare(
				`SELECT id, raw_mime_key FROM email_messages WHERE id = 'message-1'`,
			)
			.get(),
	).toEqual({
		id: 'message-1',
		raw_mime_key: 'email-raw:v1:stable-alice/message-1',
	})
	expect(
		db
			.prepare(
				`SELECT id, message_id FROM email_attachments WHERE id = 'attachment-1'`,
			)
			.get(),
	).toEqual({ id: 'attachment-1', message_id: 'message-1' })
	expect(
		db
			.prepare(
				`SELECT id, message_id FROM email_delivery_events WHERE id = 'event-1'`,
			)
			.get(),
	).toEqual({ id: 'event-1', message_id: 'message-1' })
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})

test('drop email raw mime inline migration fails closed when inline raw_mime remains', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeDrop(db)
	seedCleanEmailMessage(db)
	db.prepare(
		`UPDATE email_messages SET raw_mime = ? WHERE id = 'message-1'`,
	).run('Subject: Test\r\n\r\nBody')

	expect(() =>
		applyMigrationLikeD1(db, dropEmailRawMimeInlineMigration),
	).toThrow(/CHECK constraint failed: 0/)

	expect(emailMessagesColumnNames(db)).toContain('raw_mime')
	expect(emailMessagesColumnNames(db)).toContain('raw_mime_offload_blocked')
	expect(emailMessagesIndexes(db)).toContain(
		'idx_email_messages_raw_mime_offload_unblocked',
	)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name = 'email_raw_mime_cleanup_queue'`,
			)
			.get(),
	).toEqual({ name: 'email_raw_mime_cleanup_queue' })
	expect(
		db
			.prepare(`SELECT raw_mime FROM email_messages WHERE id = 'message-1'`)
			.get(),
	).toEqual({ raw_mime: 'Subject: Test\r\n\r\nBody' })
	expect(
		db
			.prepare(`SELECT id FROM email_attachments WHERE id = 'attachment-1'`)
			.get(),
	).toEqual({ id: 'attachment-1' })
})

test('drop email raw mime inline migration fails closed when cleanup queue rows remain', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeDrop(db)
	seedCleanEmailMessage(db)
	db.prepare(
		`INSERT INTO email_raw_mime_cleanup_queue (
			object_key, user_id, message_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?)`,
	).run(
		'email-raw:v1:stable-alice/orphan',
		'stable-alice',
		'orphan-message',
		'2026-07-01T00:00:00.000Z',
		'2026-07-01T00:00:00.000Z',
	)

	expect(() =>
		applyMigrationLikeD1(db, dropEmailRawMimeInlineMigration),
	).toThrow(/CHECK constraint failed: 0/)

	expect(emailMessagesColumnNames(db)).toContain('raw_mime')
	expect(emailMessagesColumnNames(db)).toContain('raw_mime_offload_blocked')
	expect(
		db
			.prepare(`SELECT COUNT(*) AS count FROM email_raw_mime_cleanup_queue`)
			.get(),
	).toEqual({ count: 1 })
})
