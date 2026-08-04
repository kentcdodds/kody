import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
	migrationsDirectory,
} from '#worker/test-support/system-email-graph-migration.ts'

const postdropMigration = '0140-drop-email-postdrop-residue.sql'

test('0140 drops retired tables and simplifies due-owner ordering', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, postdropMigration)
	const sql = readFileSync(
		new URL(postdropMigration, migrationsDirectory),
		'utf8',
	)
	const droppedTables = [...sql.matchAll(/^DROP TABLE (?<table>[a-z_]+);$/gmu)]
		.map((match) => match.groups?.table)
		.filter((table): table is string => table !== undefined)
	expect(droppedTables).toHaveLength(2)
	for (const table of droppedTables) {
		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_schema
					WHERE type = 'table' AND name = ?`,
				)
				.get(table),
		).toEqual({ name: table })
	}

	applyMigrationLikeD1(db, postdropMigration)

	for (const table of droppedTables) {
		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_schema
					WHERE type = 'table' AND name = ?`,
				)
				.get(table),
		).toBeUndefined()
	}
	const dueOwnerIndex = db
		.prepare(
			`SELECT sql FROM sqlite_schema
			WHERE type = 'index'
				AND name = 'idx_email_inbound_due_owners_priority_due_at'`,
		)
		.get() as { sql: string }
	expect(dueOwnerIndex.sql).toMatch(/\(due_at, user_id\)/u)
	expect(dueOwnerIndex.sql).not.toMatch(/\bCASE\b|\breason\b/u)
})
