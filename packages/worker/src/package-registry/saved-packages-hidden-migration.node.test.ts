import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function createD1FromSqlite(db: DatabaseSync) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('saved packages hidden migration defaults existing rows to visible and hydrates reads', async () => {
	const db = new DatabaseSync(':memory:')
	applyMigration(db, '0027-saved-packages.sql')
	db.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'pkg-1',
		'user-1',
		'@kentcdodds/notes',
		'notes',
		'Notes package',
		'[]',
		null,
		'source-1',
		0,
	)

	applyMigration(db, '0058-saved-packages-hidden.sql')

	expect(
		db.prepare(`SELECT hidden FROM saved_packages WHERE id = 'pkg-1'`).get(),
	).toEqual({ hidden: 0 })

	db.prepare(`UPDATE saved_packages SET hidden = 1 WHERE id = 'pkg-1'`).run()

	const { getSavedPackageById, listSavedPackagesByUserId } =
		await import('./repo.ts')
	const d1 = createD1FromSqlite(db)

	const loaded = await getSavedPackageById(d1, {
		userId: 'user-1',
		packageId: 'pkg-1',
	})
	expect(loaded).toMatchObject({
		id: 'pkg-1',
		userId: 'user-1',
		hidden: true,
	})

	const listed = await listSavedPackagesByUserId(d1, { userId: 'user-1' })
	expect(listed).toEqual([
		expect.objectContaining({ id: 'pkg-1', hidden: true }),
	])
	expect(listed.filter((row) => !row.hidden)).toEqual([])
})
