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

function seedPackage(
	db: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	db.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, '', ?, '2026-08-19', '2026-08-19')`,
	).run(
		input.id,
		input.userId,
		`@user/${input.kodyId}`,
		input.kodyId,
		`source-${input.id}`,
	)
}

test('0017 maps single-package grants, explodes multi-package grants, and drops wildcards', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(baselineSql)
	seedPackage(db, { id: 'pkg-a', userId: 'user-1', kodyId: 'alpha' })
	seedPackage(db, { id: 'pkg-b', userId: 'user-1', kodyId: 'beta' })
	seedPackage(db, { id: 'pkg-c', userId: 'user-1', kodyId: 'gamma' })

	db.exec(`
		INSERT INTO package_invocation_tokens (
			id, user_id, name, token_hash, email, display_name,
			package_ids_json, package_kody_ids_json, export_names_json, sources_json,
			created_at, updated_at
		) VALUES
			(
				'token-single-id', 'user-1', 'Single id', 'hash-single-id',
				'a@example.com', 'A', '["pkg-a"]', '[]', '["*"]', '[]',
				'2026-08-19', '2026-08-19'
			),
			(
				'token-single-kody', 'user-1', 'Single kody', 'hash-single-kody',
				'a@example.com', 'A', '[]', '["beta"]', '["./run"]', '["cron"]',
				'2026-08-19', '2026-08-19'
			),
			(
				'token-multi', 'user-1', 'Multi', 'hash-multi',
				'a@example.com', 'A', '["pkg-a","pkg-c"]', '[]', '["*"]', '[]',
				'2026-08-19', '2026-08-19'
			),
			(
				'token-mixed', 'user-1', 'Mixed', 'hash-mixed',
				'a@example.com', 'A', '["pkg-a"]', '["beta"]', '["*"]', '[]',
				'2026-08-19', '2026-08-19'
			),
			(
				'token-star', 'user-1', 'Star', 'hash-star',
				'a@example.com', 'A', '[]', '["*"]', '["*"]', '[]',
				'2026-08-19', '2026-08-19'
			);
	`)

	db.exec(ownedTokenSql)

	const columns = db
		.prepare(`PRAGMA table_info(package_invocation_tokens)`)
		.all() as Array<{ name: string }>
	const columnNames = columns.map((column) => column.name)
	expect(columnNames).toContain('package_id')
	expect(columnNames).not.toContain('email')
	expect(columnNames).not.toContain('display_name')
	expect(columnNames).not.toContain('package_ids_json')
	expect(columnNames).not.toContain('package_kody_ids_json')

	const rows = db
		.prepare(
			`SELECT id, package_id, token_hash, name
			FROM package_invocation_tokens
			ORDER BY token_hash, package_id`,
		)
		.all() as Array<{
		id: string
		package_id: string
		token_hash: string
		name: string
	}>

	expect(rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'token-single-id',
				package_id: 'pkg-a',
				token_hash: 'hash-single-id',
			}),
			expect.objectContaining({
				id: 'token-single-kody',
				package_id: 'pkg-b',
				token_hash: 'hash-single-kody',
			}),
			expect.objectContaining({
				package_id: 'pkg-a',
				token_hash: 'hash-multi',
				name: 'Multi',
			}),
			expect.objectContaining({
				package_id: 'pkg-c',
				token_hash: 'hash-multi',
				name: 'Multi',
			}),
			expect.objectContaining({
				package_id: 'pkg-a',
				token_hash: 'hash-mixed',
				name: 'Mixed',
			}),
			expect.objectContaining({
				package_id: 'pkg-b',
				token_hash: 'hash-mixed',
				name: 'Mixed',
			}),
		]),
	)
	expect(rows).toHaveLength(6)
	expect(rows.some((row) => row.token_hash === 'hash-star')).toBe(false)
	expect(rows.filter((row) => row.token_hash === 'hash-multi')).toHaveLength(2)
	expect(rows.filter((row) => row.token_hash === 'hash-mixed')).toHaveLength(2)
})
