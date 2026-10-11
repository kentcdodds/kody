import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { insertSavedPackage } from './repo.ts'

test('insertSavedPackage stamps the actor when package owner is a team org', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const actorUserId = personIdFromStored('member-1')
	const teamOrgOwnerId = ownerIdFromStored('acme-org')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('member', 'member@example.com', 'hash', ?)`,
		)
		.run(actorUserId)

	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const at = '2026-10-11T12:00:00.000Z'

	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: teamOrgOwnerId,
			name: '@acme/tool',
			kody_id: 'tool',
			description: 'Team tool',
			tags_json: '[]',
			search_text: null,
			source_id: sourceId,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: at,
			updated_at: at,
		},
		null,
		{ actorUserId },
	)

	expect(
		sqlite
			.prepare(
				`SELECT first_saved_package_at FROM users WHERE stable_user_id = ?`,
			)
			.get(actorUserId),
	).toEqual({ first_saved_package_at: at })
})

test('insertSavedPackage falls back to row user_id when no actor is provided', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const ownerUserId = ownerIdFromStored('solo-user')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('solo', 'solo@example.com', 'hash', ?)`,
		)
		.run(ownerUserId)

	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const at = '2026-10-11T13:00:00.000Z'

	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@solo/pkg',
		kody_id: 'pkg',
		description: 'Personal package',
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
		created_at: at,
		updated_at: at,
	})

	expect(
		sqlite
			.prepare(
				`SELECT first_saved_package_at FROM users WHERE stable_user_id = ?`,
			)
			.get(ownerUserId),
	).toEqual({ first_saved_package_at: at })
})
