import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getAvailableUsernameFromBase,
	isUsernameClaimedInIdentity,
} from './generated-username.ts'
import { getUsernameValidationError } from './username.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('generated usernames suffix taken claimable bases and redraw reserved bases', async () => {
	const { sqlite, db } = createMigratedDb()
	const takenEmail = 'alice@example.com'
	const takenStableId = testStableUserIdFromEmail(takenEmail)
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'alice',
			${quoteSqlString(takenEmail)},
			${quoteSqlString(takenStableId)},
			'oauth_created_no_usable_password'
		);
	`)

	expect(await getAvailableUsernameFromBase(db, 'alice')).toBe('alice-2')

	const fromReserved = await getAvailableUsernameFromBase(db, 'support')
	expect(fromReserved).not.toBe('support')
	expect(fromReserved.includes('support')).toBe(false)
	expect(fromReserved.startsWith('user-')).toBe(false)
	expect(getUsernameValidationError(fromReserved)).toBeNull()
})

test('isUsernameClaimedInIdentity allows reclaiming own retired handle and org slug', async () => {
	const { db } = createMigratedDb()
	const stableUserId = testStableUserIdFromEmail('reclaim@example.com')
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'oldname',
		createdAt: '2026-01-01T00:00:00.000Z',
	})
	await db
		.prepare(
			`INSERT INTO users (username, email, stable_user_id, password_hash, created_at, updated_at)
			 VALUES (?, ?, ?, 'x', ?, ?)`,
		)
		.bind(
			'newname',
			'reclaim@example.com',
			stableUserId,
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
		)
		.run()
	// Simulate rename: live handle moves; org slug stays on old handle.
	await db
		.prepare(`UPDATE handles SET user_id = NULL WHERE handle = ?`)
		.bind('oldname')
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES (?, ?, NULL, ?)`,
		)
		.bind('newname', stableUserId, '2026-01-02T00:00:00.000Z')
		.run()

	expect(await isUsernameClaimedInIdentity(db, 'oldname')).toBe(true)
	expect(
		await isUsernameClaimedInIdentity(db, 'oldname', {
			exceptStableUserId: stableUserId,
		}),
	).toBe(false)
	expect(
		await isUsernameClaimedInIdentity(db, 'oldname', {
			exceptStableUserId: 'someone-else',
		}),
	).toBe(true)
})
