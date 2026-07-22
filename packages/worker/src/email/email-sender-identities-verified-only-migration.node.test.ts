import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const verifiedOnlyMigration = '0078-email-sender-identities-verified-only.sql'

const durableSenderIdentityIndexes = [
	'idx_email_sender_identities_user_domain',
	'idx_email_sender_identities_user_email',
] as const

/** D1 wraps each migration file in a transaction; PRAGMA foreign_keys=OFF is a no-op. */
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

function applyMigrationsBeforeVerifiedOnly(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < verifiedOnlyMigration)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function senderIdentitiesTableSql(db: DatabaseSync) {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'table' AND name = 'email_sender_identities'`,
		)
		.get() as { sql: string } | undefined
	return row?.sql ?? ''
}

function senderIdentityIndexes(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index'
				   AND tbl_name = 'email_sender_identities'
				   AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
}

function senderIdentityForeignKeys(db: DatabaseSync) {
	return db.prepare(`PRAGMA foreign_key_list(email_messages)`).all() as Array<{
		table: string
		from: string
		on_delete: string
	}>
}

function seedLegacySenderIdentities(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', 'stable-alice');

		INSERT INTO email_sender_identities (
			id, user_id, package_id, email, domain, display_name, status,
			verified_at, created_at, updated_at
		) VALUES
			(
				'identity-pending', 'stable-alice', NULL,
				'pending@inbox.example.com', 'inbox.example.com', '',
				'pending', NULL, '2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:00.000Z'
			),
			(
				'identity-disabled', 'stable-alice', NULL,
				'disabled@inbox.example.com', 'inbox.example.com', 'Disabled',
				'disabled', NULL, '2026-07-01T01:00:00.000Z',
				'2026-07-01T01:00:00.000Z'
			),
			(
				'identity-verified', 'stable-alice', 'pkg-1',
				'alice@inbox.example.com', 'inbox.example.com', 'Alice',
				'verified', '2026-07-01T02:00:00.000Z',
				'2026-07-01T02:00:00.000Z', '2026-07-01T02:00:00.000Z'
			);

		INSERT INTO email_messages (
			id, direction, user_id, sender_identity_id, from_address,
			processing_status, created_at, updated_at
		) VALUES
			(
				'message-pending', 'outbound', 'stable-alice', 'identity-pending',
				'pending@inbox.example.com', 'sent',
				'2026-07-01T03:00:00.000Z', '2026-07-01T03:00:00.000Z'
			),
			(
				'message-disabled', 'outbound', 'stable-alice', 'identity-disabled',
				'disabled@inbox.example.com', 'sent',
				'2026-07-01T04:00:00.000Z', '2026-07-01T04:00:00.000Z'
			),
			(
				'message-verified', 'outbound', 'stable-alice', 'identity-verified',
				'alice@inbox.example.com', 'sent',
				'2026-07-01T05:00:00.000Z', '2026-07-01T05:00:00.000Z'
			),
			(
				'message-unlinked', 'inbound', 'stable-alice', NULL,
				'sender@example.net', 'stored',
				'2026-07-01T06:00:00.000Z', '2026-07-01T06:00:00.000Z'
			);
	`)
}

test('email sender identities verified-only migration normalizes statuses and preserves message linkage under a D1 transaction', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeVerifiedOnly(db)
	seedLegacySenderIdentities(db)

	expect(senderIdentitiesTableSql(db)).toContain(
		"status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'disabled'))",
	)
	expect(senderIdentityIndexes(db)).toEqual([...durableSenderIdentityIndexes])
	expect(
		senderIdentityForeignKeys(db).some(
			(foreignKey) =>
				foreignKey.table === 'email_sender_identities' &&
				foreignKey.from === 'sender_identity_id' &&
				foreignKey.on_delete === 'SET NULL',
		),
	).toBe(true)
	expect(
		db
			.prepare(
				`SELECT id, status, verified_at FROM email_sender_identities
				 ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'identity-disabled',
			status: 'disabled',
			verified_at: null,
		},
		{
			id: 'identity-pending',
			status: 'pending',
			verified_at: null,
		},
		{
			id: 'identity-verified',
			status: 'verified',
			verified_at: '2026-07-01T02:00:00.000Z',
		},
	])

	applyMigrationLikeD1(db, verifiedOnlyMigration)

	expect(senderIdentitiesTableSql(db)).toContain(
		"status TEXT NOT NULL CHECK (status IN ('verified'))",
	)
	expect(senderIdentitiesTableSql(db)).not.toContain('pending')
	expect(senderIdentitiesTableSql(db)).not.toContain('disabled')
	expect(senderIdentityIndexes(db)).toEqual([...durableSenderIdentityIndexes])
	expect(
		db
			.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '_mig0078_%'`)
			.all(),
	).toEqual([])
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])

	expect(
		db
			.prepare(
				`SELECT id, user_id, package_id, email, domain, display_name, status,
					verified_at, created_at, updated_at
				 FROM email_sender_identities
				 ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'identity-disabled',
			user_id: 'stable-alice',
			package_id: null,
			email: 'disabled@inbox.example.com',
			domain: 'inbox.example.com',
			display_name: 'Disabled',
			status: 'verified',
			verified_at: '2026-07-01T01:00:00.000Z',
			created_at: '2026-07-01T01:00:00.000Z',
			updated_at: '2026-07-01T01:00:00.000Z',
		},
		{
			id: 'identity-pending',
			user_id: 'stable-alice',
			package_id: null,
			email: 'pending@inbox.example.com',
			domain: 'inbox.example.com',
			display_name: '',
			status: 'verified',
			verified_at: '2026-07-01T00:00:00.000Z',
			created_at: '2026-07-01T00:00:00.000Z',
			updated_at: '2026-07-01T00:00:00.000Z',
		},
		{
			id: 'identity-verified',
			user_id: 'stable-alice',
			package_id: 'pkg-1',
			email: 'alice@inbox.example.com',
			domain: 'inbox.example.com',
			display_name: 'Alice',
			status: 'verified',
			verified_at: '2026-07-01T02:00:00.000Z',
			created_at: '2026-07-01T02:00:00.000Z',
			updated_at: '2026-07-01T02:00:00.000Z',
		},
	])

	expect(
		db
			.prepare(`SELECT id, sender_identity_id FROM email_messages ORDER BY id`)
			.all(),
	).toEqual([
		{ id: 'message-disabled', sender_identity_id: 'identity-disabled' },
		{ id: 'message-pending', sender_identity_id: 'identity-pending' },
		{ id: 'message-unlinked', sender_identity_id: null },
		{ id: 'message-verified', sender_identity_id: 'identity-verified' },
	])

	expect(
		senderIdentityForeignKeys(db).some(
			(foreignKey) =>
				foreignKey.table === 'email_sender_identities' &&
				foreignKey.from === 'sender_identity_id' &&
				foreignKey.on_delete === 'SET NULL',
		),
	).toBe(true)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])

	expect(() => {
		db.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, domain, display_name, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, '', 'pending', ?, ?)`,
		).run(
			'identity-reject-pending',
			'stable-alice',
			'reject-pending@inbox.example.com',
			'inbox.example.com',
			'2026-07-02T00:00:00.000Z',
			'2026-07-02T00:00:00.000Z',
		)
	}).toThrow(/CHECK constraint failed/)

	expect(() => {
		db.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, domain, display_name, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, '', 'disabled', ?, ?)`,
		).run(
			'identity-reject-disabled',
			'stable-alice',
			'reject-disabled@inbox.example.com',
			'inbox.example.com',
			'2026-07-02T00:00:00.000Z',
			'2026-07-02T00:00:00.000Z',
		)
	}).toThrow(/CHECK constraint failed/)

	db.prepare(
		`INSERT INTO email_sender_identities (
			id, user_id, email, domain, display_name, status, verified_at,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, '', 'verified', ?, ?, ?)`,
	).run(
		'identity-new-verified',
		'stable-alice',
		'new@inbox.example.com',
		'inbox.example.com',
		'2026-07-02T00:00:00.000Z',
		'2026-07-02T00:00:00.000Z',
		'2026-07-02T00:00:00.000Z',
	)
	expect(
		db
			.prepare(`SELECT status FROM email_sender_identities WHERE id = ?`)
			.get('identity-new-verified'),
	).toEqual({ status: 'verified' })
})

test('email sender identities verified-only migration rolls back when rebuild linkage restore would be incomplete', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeVerifiedOnly(db)
	seedLegacySenderIdentities(db)

	const beforeIdentities = db
		.prepare(
			`SELECT id, status, verified_at FROM email_sender_identities
			 ORDER BY id`,
		)
		.all()
	const beforeMessages = db
		.prepare(`SELECT id, sender_identity_id FROM email_messages ORDER BY id`)
		.all()

	expect(() => {
		db.exec('BEGIN')
		try {
			db.exec(`
				UPDATE email_sender_identities
				SET
					status = 'verified',
					verified_at = COALESCE(verified_at, created_at);

				CREATE TABLE _mig0078_email_message_sender_refs AS
				SELECT id AS message_id, sender_identity_id
				FROM email_messages
				WHERE sender_identity_id IS NOT NULL;

				CREATE TABLE email_sender_identities_next (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					package_id TEXT,
					email TEXT NOT NULL,
					domain TEXT,
					display_name TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL CHECK (status IN ('verified')),
					verified_at TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);

				INSERT INTO email_sender_identities_next
				SELECT * FROM email_sender_identities;

				DROP TABLE email_sender_identities;
				ALTER TABLE email_sender_identities_next
				RENAME TO email_sender_identities;

				CREATE TABLE __migration_assertions (
					message TEXT NOT NULL CHECK (0)
				);
				INSERT INTO __migration_assertions (message)
				SELECT 'forced abort before sender_identity_id restore';
			`)
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}).toThrow(/CHECK constraint failed: 0/)

	expect(senderIdentitiesTableSql(db)).toContain(
		"status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'disabled'))",
	)
	expect(
		db
			.prepare(
				`SELECT id, status, verified_at FROM email_sender_identities
				 ORDER BY id`,
			)
			.all(),
	).toEqual(beforeIdentities)
	expect(
		db
			.prepare(`SELECT id, sender_identity_id FROM email_messages ORDER BY id`)
			.all(),
	).toEqual(beforeMessages)
	expect(
		db
			.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '_mig0078_%'`)
			.all(),
	).toEqual([])
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
