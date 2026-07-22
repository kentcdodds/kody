import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const dropReplyTokenHashMigration =
	'0079-drop-email-inbox-address-reply-token-hash.sql'

const durableInboxAddressIndexes = [
	'idx_email_inbox_addresses_address',
	'idx_email_inbox_addresses_inbox_id',
] as const

/** D1 wraps each migration file in a transaction; mirror that in tests. */
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
			(file) => file.endsWith('.sql') && file < dropReplyTokenHashMigration,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function inboxAddressColumnNames(db: DatabaseSync) {
	return (
		db.prepare(`PRAGMA table_info(email_inbox_addresses)`).all() as Array<{
			name: string
		}>
	).map((column) => column.name)
}

function inboxAddressIndexes(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index'
				   AND tbl_name = 'email_inbox_addresses'
				   AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
}

function inboxAddressForeignKeys(db: DatabaseSync) {
	return db
		.prepare(`PRAGMA foreign_key_list(email_inbox_addresses)`)
		.all() as Array<{
		table: string
		from: string
		to: string
		on_delete: string
	}>
}

function seedInboxAddressesWithReplyTokenHash(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', 'stable-alice');

		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES (
			'inbox-1', 'stable-alice', 'Primary', 'Primary inbox', 1,
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
		);

		INSERT INTO email_inbox_addresses (
			id, inbox_id, user_id, address, local_part, domain, reply_token_hash,
			enabled, created_at, updated_at
		) VALUES
			(
				'address-1', 'inbox-1', 'stable-alice',
				'alice@inbox.example.com', 'alice', 'inbox.example.com',
				'hash-token-1', 1,
				'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
			),
			(
				'address-2', 'inbox-1', 'stable-alice',
				'support@inbox.example.com', 'support', 'inbox.example.com',
				NULL, 0,
				'2026-07-01T01:00:00.000Z', '2026-07-01T01:00:00.000Z'
			);
	`)
}

test('drop email inbox address reply token hash migration removes column and preserves rows, indexes, and foreign keys', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeDrop(db)
	seedInboxAddressesWithReplyTokenHash(db)

	expect(inboxAddressColumnNames(db)).toContain('reply_token_hash')
	expect(inboxAddressIndexes(db)).toEqual([
		...durableInboxAddressIndexes,
		'idx_email_inbox_addresses_reply_token',
	])
	expect(
		inboxAddressForeignKeys(db).some(
			(foreignKey) =>
				foreignKey.table === 'email_inboxes' &&
				foreignKey.from === 'inbox_id' &&
				foreignKey.to === 'id' &&
				foreignKey.on_delete === 'CASCADE',
		),
	).toBe(true)
	expect(
		db
			.prepare(
				`SELECT id, reply_token_hash FROM email_inbox_addresses ORDER BY id`,
			)
			.all(),
	).toEqual([
		{ id: 'address-1', reply_token_hash: 'hash-token-1' },
		{ id: 'address-2', reply_token_hash: null },
	])

	applyMigrationLikeD1(db, dropReplyTokenHashMigration)

	expect(inboxAddressColumnNames(db)).not.toContain('reply_token_hash')
	expect(inboxAddressIndexes(db)).toEqual([...durableInboxAddressIndexes])
	expect(
		inboxAddressForeignKeys(db).some(
			(foreignKey) =>
				foreignKey.table === 'email_inboxes' &&
				foreignKey.from === 'inbox_id' &&
				foreignKey.to === 'id' &&
				foreignKey.on_delete === 'CASCADE',
		),
	).toBe(true)
	expect(
		db
			.prepare(
				`SELECT id, inbox_id, user_id, address, local_part, domain, enabled,
					created_at, updated_at
				 FROM email_inbox_addresses
				 ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'address-1',
			inbox_id: 'inbox-1',
			user_id: 'stable-alice',
			address: 'alice@inbox.example.com',
			local_part: 'alice',
			domain: 'inbox.example.com',
			enabled: 1,
			created_at: '2026-07-01T00:00:00.000Z',
			updated_at: '2026-07-01T00:00:00.000Z',
		},
		{
			id: 'address-2',
			inbox_id: 'inbox-1',
			user_id: 'stable-alice',
			address: 'support@inbox.example.com',
			local_part: 'support',
			domain: 'inbox.example.com',
			enabled: 0,
			created_at: '2026-07-01T01:00:00.000Z',
			updated_at: '2026-07-01T01:00:00.000Z',
		},
	])
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
