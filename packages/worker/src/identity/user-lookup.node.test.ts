import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { findPublicOwnerIdentityByHandle } from './user-lookup.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			display_name TEXT,
			suspended_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE handles (
			handle TEXT PRIMARY KEY,
			user_id TEXT,
			org_id TEXT,
			created_at TEXT NOT NULL
		);
	`)
	return createD1FromSqlite(sqlite)
}

test('findPublicOwnerIdentityByHandle resolves team org handles without a users row', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, suspended_at, deleted_at)
			 VALUES (?, ?, 'Kody', NULL, NULL)`,
		)
		.bind('org-kody', 'kody')
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('kody', NULL, 'org-kody', ?)`,
		)
		.bind(new Date().toISOString())
		.run()

	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'kody' }),
	).resolves.toEqual({
		handle: 'kody',
		ownerId: ownerIdFromStored('org-kody'),
	})
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'Kody' }),
	).resolves.toEqual({
		handle: 'kody',
		ownerId: ownerIdFromStored('org-kody'),
	})
})

test('findPublicOwnerIdentityByHandle skips reserved and suspended orgs', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('reserved', NULL, NULL, ?)`,
		)
		.bind(new Date().toISOString())
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, suspended_at, deleted_at)
			 VALUES (?, ?, 'Gone', ?, NULL)`,
		)
		.bind('org-suspended', 'suspended', new Date().toISOString())
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('suspended', NULL, 'org-suspended', ?)`,
		)
		.bind(new Date().toISOString())
		.run()

	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'reserved' }),
	).resolves.toBeNull()
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'suspended' }),
	).resolves.toBeNull()
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'missing' }),
	).resolves.toBeNull()
})
