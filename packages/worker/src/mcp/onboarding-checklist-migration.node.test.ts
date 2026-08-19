import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0015-users-onboarding-checklist-dismissed-at.sql'
const userId = 'a'.repeat(64)

function applyMigrationsBeforeOnboardingColumn(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(fileName) => fileName.endsWith('.sql') && fileName < migrationFileName,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyOnboardingColumnMigration(db: DatabaseSync) {
	db.exec(readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'))
}

test('0015 backfills user dismissals and leaves non-user leftover rows intact', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeOnboardingColumn(db)

	db.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(
		'user-onboarding',
		'user-onboarding@example.test',
		'test-password-hash',
		'2026-08-01T00:00:00.000Z',
		userId,
	)
	db.prepare(
		`INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?)`,
	).run(
		'vb-user',
		userId,
		'user',
		'2026-08-01T00:00:00.000Z',
		'2026-08-01T00:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?)`,
	).run(
		'vb-session',
		userId,
		'session',
		'2026-08-01T00:00:00.000Z',
		'2026-08-01T00:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		 VALUES (?, 'onboardingChecklistDismissed', '', ?, ?, ?)`,
	).run(
		'vb-user',
		'2026-08-01T12:00:00.000Z',
		'2026-08-01T12:00:00.000Z',
		'2026-08-01T12:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		 VALUES (?, 'onboardingChecklistDismissed', '', ?, ?, ?)`,
	).run(
		'vb-session',
		'keep-session',
		'2026-08-01T12:00:00.000Z',
		'2026-08-01T12:00:00.000Z',
	)

	applyOnboardingColumnMigration(db)

	const dismissedAt = db
		.prepare(
			`SELECT onboarding_checklist_dismissed_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.get(userId) as { onboarding_checklist_dismissed_at: string | null }
	expect(dismissedAt.onboarding_checklist_dismissed_at).toBe(
		'2026-08-01T12:00:00.000Z',
	)

	const leftover = db
		.prepare(
			`SELECT ve.bucket_id, ve.value, vb.scope
			 FROM value_entries ve
			 INNER JOIN value_buckets vb ON vb.id = ve.bucket_id
			 WHERE ve.name = 'onboardingChecklistDismissed'
			 ORDER BY vb.scope`,
		)
		.all() as Array<{ bucket_id: string; value: string; scope: string }>
	expect(leftover).toEqual([
		{ bucket_id: 'vb-session', value: 'keep-session', scope: 'session' },
	])
})
