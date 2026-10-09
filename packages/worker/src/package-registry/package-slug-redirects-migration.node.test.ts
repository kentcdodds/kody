import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0081-package-slug-redirects.sql'

function applyMigrationsBefore(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(fileName) => fileName.endsWith('.sql') && fileName < migrationFileName,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

test('0081 creates package_slug_redirects and copies every package_kody_id_redirects row', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db)
	const legacyRows = [
		['user-a', 'old-notes', 'pkg-a', '2026-01-01T00:00:00Z'],
		['user-a', 'older-notes', 'pkg-a', '2026-01-02T00:00:00Z'],
		['user-a', 'old-bot', 'pkg-b', '2026-02-01T00:00:00Z'],
		['user-b', 'old-notes', 'pkg-c', '2026-03-01T00:00:00Z'],
		['user-b', 'legacy', 'pkg-d', '2026-04-01T00:00:00Z'],
		['user-c', 'gone', 'pkg-e', '2026-05-01T00:00:00Z'],
	] as const
	const insert = db.prepare(
		`INSERT INTO package_kody_id_redirects (user_id, old_kody_id, package_id, created_at)
		VALUES (?, ?, ?, ?)`,
	)
	for (const row of legacyRows) insert.run(...row)

	db.exec(readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'))

	const copied = db
		.prepare(
			`SELECT user_id, old_slug, package_id, created_at
			FROM package_slug_redirects
			ORDER BY user_id, old_slug`,
		)
		.all()
	expect(copied).toEqual(
		[...legacyRows]
			.sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`))
			.map(([user_id, old_slug, package_id, created_at]) => ({
				user_id,
				old_slug,
				package_id,
				created_at,
			})),
	)
	// #1909 proof query P5: the slug table is a superset of the legacy one.
	expect(
		db
			.prepare(
				`SELECT COUNT(*) AS missing FROM package_kody_id_redirects o
				LEFT JOIN package_slug_redirects n
					ON n.user_id = o.user_id AND n.old_slug = o.old_kody_id
					AND n.package_id = o.package_id
				WHERE n.user_id IS NULL`,
			)
			.get(),
	).toEqual({ missing: 0 })
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'index' AND tbl_name = 'package_slug_redirects'
					AND name NOT LIKE 'sqlite_autoindex_%'`,
			)
			.all(),
	).toEqual([{ name: 'idx_package_slug_redirects_package_id' }])
	expect(() =>
		db
			.prepare(
				`INSERT INTO package_slug_redirects (user_id, old_slug, package_id)
				VALUES ('user-a', 'old-notes', 'pkg-z')`,
			)
			.run(),
	).toThrow(/UNIQUE/)
})
