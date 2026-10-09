import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

test('Teams expand migration 0086 defines org primitives', () => {
	const migrationsDirectory = new URL('../../migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('0086-teams-orgs-tables.sql', migrationsDirectory),
			'utf8',
		),
	)
	const orgs = sqlite
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orgs'`,
		)
		.get()
	expect(orgs).toBeTruthy()
	const handles = sqlite
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handles'`,
		)
		.get()
	expect(handles).toBeTruthy()
})
