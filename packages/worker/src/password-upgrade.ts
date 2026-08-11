import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	createPasswordHash,
	passwordHashNeedsUpgrade,
} from '@kody-internal/shared/password-hash.ts'
import { type AppDatabase, usersTable } from './db.ts'

/**
 * Transparently re-hash a verified password when the stored hash predates the
 * current PBKDF2 settings. `password_changed_at` is untouched: the credential
 * itself did not change, only its storage format.
 */
export async function upgradePasswordHashIfNeeded(
	db: AppDatabase,
	userId: number,
	verifiedPassword: string,
	storedHash: string,
) {
	if (!passwordHashNeedsUpgrade(storedHash)) return
	const passwordHash = await createPasswordHash(verifiedPassword)
	await db.update(usersTable, userId, {
		password_hash: passwordHash,
		updated_at: utcSqliteTimestamp(),
	})
}
