import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const baselineSql = readFileSync(
	new URL('0001-squashed-init.sql', migrationsDirectory),
	'utf8',
)
const ownedTokenSql = readFileSync(
	new URL('0017-package-owned-invocation-tokens.sql', migrationsDirectory),
	'utf8',
)
const dropSourcesSql = readFileSync(
	new URL('0019-drop-invocation-token-sources.sql', migrationsDirectory),
	'utf8',
)

test('0019 drops sources_json and keeps package-owned token rows', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(baselineSql)
	db.exec(ownedTokenSql)
	db.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, '', ?, '2026-08-19', '2026-08-19')`,
	).run('pkg-a', 'user-1', '@user/alpha', 'alpha', 'source-pkg-a')
	db.prepare(
		`INSERT INTO package_invocation_tokens (
			id, user_id, package_id, name, token_hash, export_names_json,
			sources_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-19', '2026-08-19')`,
	).run(
		'token-1',
		'user-1',
		'pkg-a',
		'Weekly site perf',
		'hash-1',
		'["."]',
		'["weekly-site-perf"]',
	)

	db.exec(dropSourcesSql)

	const columns = db
		.prepare(`PRAGMA table_info(package_invocation_tokens)`)
		.all() as Array<{ name: string }>
	const columnNames = columns.map((column) => column.name)
	expect(columnNames).toContain('package_id')
	expect(columnNames).toContain('export_names_json')
	expect(columnNames).not.toContain('sources_json')

	const rows = db
		.prepare(
			`SELECT id, user_id, package_id, name, token_hash, export_names_json
			FROM package_invocation_tokens`,
		)
		.all() as Array<{
		id: string
		user_id: string
		package_id: string
		name: string
		token_hash: string
		export_names_json: string
	}>
	expect(rows).toEqual([
		{
			id: 'token-1',
			user_id: 'user-1',
			package_id: 'pkg-a',
			name: 'Weekly site perf',
			token_hash: 'hash-1',
			export_names_json: '["."]',
		},
	])
})
