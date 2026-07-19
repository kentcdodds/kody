import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

test('platform feedback submitter snapshot migration preserves legacy rows as null', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(
		readFileSync(
			new URL('0062-platform-feedback.sql', migrationsDirectory),
			'utf8',
		),
	)
	db.exec(`
		INSERT INTO platform_feedback (
			id, submitter_user_id, category, summary, details, created_at, updated_at
		) VALUES (
			'legacy-feedback', 'legacy-user', 'friction', 'Legacy summary',
			'Legacy details', '2026-07-19', '2026-07-19'
		)
	`)

	db.exec(
		readFileSync(
			new URL(
				'0063-platform-feedback-submitter-snapshot.sql',
				migrationsDirectory,
			),
			'utf8',
		),
	)

	expect(
		db
			.prepare(
				`SELECT submitter_username, submitter_email
				 FROM platform_feedback
				 WHERE id = 'legacy-feedback'`,
			)
			.get(),
	).toEqual({
		submitter_username: null,
		submitter_email: null,
	})
	const columns = db
		.prepare(`PRAGMA table_info(platform_feedback)`)
		.all() as Array<{ name: string; notnull: number }>
	expect(
		columns
			.filter((column) =>
				['submitter_username', 'submitter_email'].includes(column.name),
			)
			.map((column) => ({
				name: column.name,
				notnull: column.notnull,
			})),
	).toEqual([
		{ name: 'submitter_username', notnull: 0 },
		{ name: 'submitter_email', notnull: 0 },
	])
})
