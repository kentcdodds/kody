import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { getAvailableUsernameFromBase } from './generated-username.ts'
import { getUsernameValidationError } from './username.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('generated usernames suffix taken claimable bases and redraw reserved bases', async () => {
	const { sqlite, db } = createMigratedDb()
	const takenEmail = 'alice@example.com'
	const takenStableId = await createStableUserIdFromEmail(takenEmail)
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
