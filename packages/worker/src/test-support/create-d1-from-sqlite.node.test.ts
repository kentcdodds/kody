import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from './create-d1-from-sqlite.ts'

test('overlapping batch() calls serialize like production D1', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('create table items (id integer primary key, name text)')
	const db = createD1FromSqlite(sqlite)

	const insert = (name: string) =>
		db.batch([db.prepare('insert into items (name) values (?)').bind(name)])

	await expect(Promise.all([insert('a'), insert('b')])).resolves.toHaveLength(2)

	const rows = await db.prepare('select name from items order by id').all<{
		name: string
	}>()
	expect(rows.results.map((row) => row.name).sort()).toEqual(['a', 'b'])
})

test('a failed batch does not permanently lock later batches', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('create table items (id integer primary key, name text not null)')
	const db = createD1FromSqlite(sqlite)

	await expect(
		db.batch([db.prepare('insert into items (name) values (null)')]),
	).rejects.toThrow()

	await expect(
		db.batch([db.prepare("insert into items (name) values ('ok')")]),
	).resolves.toHaveLength(1)
	const row = await db
		.prepare('select name from items')
		.first<{ name: string }>()
	expect(row).toEqual({ name: 'ok' })
})
