import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { updateAdminUserSuspension } from '#worker/admin/users-data.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import * as workerDb from '#worker/db.ts'
import { createDb } from '#worker/db.ts'
import { applyPasswordChange } from './apply-password-change.ts'
import {
	invalidatePackageAppOwnerCache,
	invalidatePackageAppOwnerCacheForDbUserId,
	resolvePackageAppOrgOwnerByHandle,
	resolvePackageAppOwnerByStableUserId,
} from './package-app-owner.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
async function seedOwnerUser() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const email = 'pkg-owner-cache@example.com'
	const passwordHash = await createPasswordHash('password-ok')
	const stableUserId = testStableUserIdFromEmail(email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1, 'pkg-owner-cache', ${quoteSqlString(email)},
			${quoteSqlString(stableUserId)}, ${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
	const d1 = createD1FromSqlite(sqlite)
	const env = { APP_DB: d1 } as Env
	return { sqlite, d1, env, stableUserId, db: createDb(d1) }
}

const oauthHelpers = {
	listUserGrants: async () => ({ items: [] }),
	revokeGrant: async () => {},
} as never

test('resolvePackageAppOwnerByStableUserId warms per stableUserId and skips repeat D1 reads', async () => {
	const { env, stableUserId } = await seedOwnerUser()
	invalidatePackageAppOwnerCache({ stableUserId })
	let findOneCalls = 0
	const originalCreateDb = workerDb.createDb
	const createDbSpy = vi
		.spyOn(workerDb, 'createDb')
		.mockImplementation((database) => {
			const db = originalCreateDb(database)
			const findOne = db.findOne.bind(db)
			const countingFindOne = (async (...args: Parameters<typeof findOne>) => {
				findOneCalls += 1
				return findOne(...args)
			}) as typeof db.findOne
			db.findOne = countingFindOne
			return db
		})
	const issuedAt = Date.now()

	const first = await resolvePackageAppOwnerByStableUserId({
		env,
		stableUserId,
		issuedAt,
	})
	const second = await resolvePackageAppOwnerByStableUserId({
		env,
		stableUserId,
		issuedAt,
	})

	expect(first?.userId).toBe(stableUserId)
	expect(second).toEqual(first)
	expect(findOneCalls).toBe(1)
	createDbSpy.mockRestore()
})

test('admin suspend and unsuspend invalidate the owner cache through real users-data', async () => {
	const { env, stableUserId, d1 } = await seedOwnerUser()
	invalidatePackageAppOwnerCache({ stableUserId })
	const issuedAt = Date.now()
	const warm = await resolvePackageAppOwnerByStableUserId({
		env,
		stableUserId,
		issuedAt,
	})
	expect(warm).not.toBeNull()

	await updateAdminUserSuspension(d1, {
		stableUserId,
		suspended: true,
	})
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt,
		}),
	).toBeNull()

	await updateAdminUserSuspension(d1, {
		stableUserId,
		suspended: false,
	})
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt,
		}),
	).toMatchObject({ userId: stableUserId })
})

test('soft-deleted owners resolve to null and db-id invalidation still clears cache', async () => {
	const { env, stableUserId, d1 } = await seedOwnerUser()
	invalidatePackageAppOwnerCache({ stableUserId })
	const issuedAt = Date.now()
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt,
		}),
	).not.toBeNull()

	await d1
		.prepare(`UPDATE users SET deleted_at = ? WHERE id = 1`)
		.bind(new Date().toISOString())
		.run()
	await invalidatePackageAppOwnerCacheForDbUserId(d1, 1)
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt,
		}),
	).toBeNull()
})

test('applyPasswordChange invalidates sessions issued before the stamp', async () => {
	const { env, stableUserId, db, d1 } = await seedOwnerUser()
	invalidatePackageAppOwnerCache({ stableUserId })
	const issuedBeforeChange = Date.now() - 60_000
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt: issuedBeforeChange,
		}),
	).not.toBeNull()

	const result = await applyPasswordChange({
		db,
		d1,
		helpers: oauthHelpers,
		userId: 1,
		stableUserId: ownerIdFromStored(stableUserId),
		password: 'new-password-ok',
	})
	expect(result.ok).toBe(true)

	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt: issuedBeforeChange,
		}),
	).toBeNull()
	expect(
		await resolvePackageAppOwnerByStableUserId({
			env,
			stableUserId,
			issuedAt: Date.now(),
		}),
	).toMatchObject({ userId: stableUserId })
})

test('resolvePackageAppOrgOwnerByHandle returns the org named in the handle', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const now = '2026-01-01T00:00:00.000Z'
	const teamId = 'org-acme'
	sqlite.exec(`
		INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		VALUES ('${teamId}', 'acme', 'Acme Apps', '${now}', '${now}');
		INSERT INTO handles (handle, org_id, created_at)
		VALUES ('acme', '${teamId}', '${now}');
		INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		VALUES ('person-pat', 'pat', NULL, '${now}', '${now}');
		INSERT INTO handles (handle, org_id, created_at)
		VALUES ('pat', 'person-pat', '${now}');
	`)
	const env = { APP_DB: createD1FromSqlite(sqlite) } as Env

	await expect(
		resolvePackageAppOrgOwnerByHandle({ env, handle: 'acme' }),
	).resolves.toEqual({
		userId: teamId,
		username: 'acme',
		displayName: 'Acme Apps',
	})
	await expect(
		resolvePackageAppOrgOwnerByHandle({ env, handle: 'pat' }),
	).resolves.toEqual({
		userId: 'person-pat',
		username: 'pat',
		displayName: 'pat',
	})
	await expect(
		resolvePackageAppOrgOwnerByHandle({ env, handle: 'missing' }),
	).resolves.toBeNull()
})
