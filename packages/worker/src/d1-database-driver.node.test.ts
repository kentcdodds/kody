import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { column as c, table } from 'remix/data-table'
import { D1DatabaseDriver } from './d1-data-table-adapter.ts'
import { createDb } from '#worker/db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const accountsTable = table({
	name: 'accounts',
	columns: {
		id: c.text(),
		status: c.text(),
		email: c.text(),
	},
	primaryKey: 'id',
})

const d1Driver = new D1DatabaseDriver({} as D1Database)

test('D1 database driver compiles upsert bindings in placeholder order', () => {
	const statement = d1Driver.compileSql({
		kind: 'upsert',
		table: accountsTable,
		values: { status: 'enabled', email: 'contact@remix.run' },
		conflictTarget: ['id'],
		update: { email: 'info@remix.run' },
	})[0]!

	expect(statement.text).toBe(
		'insert into "accounts" ("status", "email") values (?, ?) on conflict ("id") do update set "email" = ?',
	)
	expect(statement.values).toEqual([
		'enabled',
		'contact@remix.run',
		'info@remix.run',
	])
})

test('D1 database driver rejects invalid order by directions', () => {
	expect(() =>
		d1Driver.compileSql({
			kind: 'select',
			table: accountsTable,
			select: '*',
			distinct: false,
			joins: [],
			where: [],
			groupBy: [],
			having: [],
			orderBy: [{ column: 'email', direction: 'ascending' as 'asc' }],
		}),
	).toThrowError(
		new TypeError('Invalid order by direction: expected "asc" or "desc"'),
	)
})

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
