import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
} from '#worker/test-support/system-email-graph-migration.ts'

const postdropMigration = '0143-drop-email-postdrop-residue.sql'
const retiredTables = [
	'email_user_graph_drop_approval',
	'email_inbound_usage_effects',
] as const

test('0143 drops retired tables and simplifies due-owner ordering', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, postdropMigration)
	for (const table of retiredTables) {
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

	for (const table of retiredTables) {
		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_schema
					WHERE type = 'table' AND name = ?`,
				)
				.get(table),
		).toBeUndefined()
	}
	expect(() => applyMigrationLikeD1(db, postdropMigration)).not.toThrow()
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
