import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createDb } from '#worker/db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

test('D1 database driver queries, wipes, and closes through the Remix Database API', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createDb(createD1FromSqlite(sqlite))

	await db.executeScript(
		'create table widgets (id integer primary key, name text)',
	)
	expect(await db.hasTable({ name: 'widgets' })).toBe(true)

	await db.exec({
		text: 'insert into widgets (name) values (?)',
		values: ['alpha'],
	})
	const selected = await db.exec('select name from widgets order by id')
	expect(selected.rows?.map((row) => row.name)).toEqual(['alpha'])

	await db.executeScript(`
		pragma foreign_keys = on;
		create table parents (id integer primary key);
		create table children (
			id integer primary key,
			parent_id integer not null references parents(id)
		);
		insert into parents (id) values (1);
		insert into children (id, parent_id) values (1, 1);
	`)
	expect(await db.hasTable({ name: 'parents' })).toBe(true)
	expect(await db.hasTable({ name: 'children' })).toBe(true)

	await db.wipe()
	expect(await db.hasTable({ name: 'widgets' })).toBe(false)
	expect(await db.hasTable({ name: 'parents' })).toBe(false)
	expect(await db.hasTable({ name: 'children' })).toBe(false)

	await db.close()
})
