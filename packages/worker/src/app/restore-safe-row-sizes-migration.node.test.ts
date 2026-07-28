import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const restoreSafeRowSizesMigration = '0105-restore-safe-row-sizes.sql'

/** D1 wraps each migration file in a transaction; mirror that here. */
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

function applyMigrationsBefore(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(file) => file.endsWith('.sql') && file < restoreSafeRowSizesMigration,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function seedRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', 'stable-alice');
	`)
	const insertInvocation = db.prepare(
		`INSERT INTO package_invocations (
			id, user_id, token_id, package_id, package_kody_id, export_name,
			idempotency_key, request_hash, status, response_json,
			created_at, updated_at
		) VALUES (?, 'stable-alice', 'token-1', 'pkg-1', 'pkg-1', '.', ?, 'hash',
			'completed', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	)
	insertInvocation.run('inv-small', 'key-small', '{"status":200,"body":{}}')
	insertInvocation.run(
		'inv-oversized',
		'key-oversized',
		`{"status":200,"body":{"blob":"${'x'.repeat(70_000)}"}}`,
	)
	const insertEmail = db.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, raw_mime_key, raw_size,
			processing_status, text_body, html_body, created_at, updated_at
		) VALUES (?, 'inbound', 'stable-alice', 'sender@example.com',
			?, 128, 'stored', ?, ?,
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	)
	insertEmail.run(
		'email-small',
		'email-raw:v1:stable-alice/email-small',
		'short text',
		'<p>short html</p>',
	)
	insertEmail.run(
		'email-oversized',
		'email-raw:v1:stable-alice/email-oversized',
		'short text',
		`<p>${'y'.repeat(70_000)}</p>`,
	)
}

test('restore-safe row sizes migration bounds oversized rows and keeps small ones', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db)
	seedRows(db)

	applyMigrationLikeD1(db, restoreSafeRowSizesMigration)

	const invocations = db
		.prepare(`SELECT id, response_json FROM package_invocations ORDER BY id`)
		.all() as Array<{ id: string; response_json: string | null }>
	expect(invocations).toEqual([
		{ id: 'inv-oversized', response_json: null },
		{ id: 'inv-small', response_json: '{"status":200,"body":{}}' },
	])

	const emails = db
		.prepare(
			`SELECT id, text_body, html_body,
				LENGTH(CAST(html_body AS BLOB)) AS html_bytes
			FROM email_messages ORDER BY id`,
		)
		.all() as Array<{
		id: string
		text_body: string | null
		html_body: string | null
		html_bytes: number
	}>
	const oversized = emails.find((row) => row.id === 'email-oversized')
	const small = emails.find((row) => row.id === 'email-small')
	expect(small?.html_body).toBe('<p>short html</p>')
	expect(oversized?.text_body).toBe('short text')
	expect(oversized?.html_bytes).toBeLessThanOrEqual(65_536)
	expect(oversized?.html_body).toContain('[truncated for backup-safe storage')
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
