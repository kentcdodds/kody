import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { hashVerificationToken } from '#worker/identity/email-verification-tokens.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { addEmailNotificationDestination } from './destinations.ts'
import { verifyEmailDestinationToken } from './destination-verification.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(sqlite: DatabaseSync) {
	const stableUserId = await createStableUserIdFromEmail('owner@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1,
			'owner',
			'owner@example.com',
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			CURRENT_TIMESTAMP
		);
	`)
}

test('destination verification tokens mark one extra address verified and reject missing/expired links', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite)
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'phone@example.com',
	})

	expect(await verifyEmailDestinationToken({ db, token: '' })).toEqual({
		ok: false,
		reason: 'missing_token',
	})
	expect(await verifyEmailDestinationToken({ db, token: 'nope' })).toEqual({
		ok: false,
		reason: 'invalid_token',
	})

	const token = 'a'.repeat(64)
	const tokenHash = await hashVerificationToken(token)
	sqlite
		.prepare(
			`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (1, ?, ?, ?)`,
		)
		.run(added.destination.id, tokenHash, Date.now() - 1)
	expect(await verifyEmailDestinationToken({ db, token })).toEqual({
		ok: false,
		reason: 'expired_token',
	})

	const liveToken = 'b'.repeat(64)
	const liveHash = await hashVerificationToken(liveToken)
	sqlite
		.prepare(
			`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (1, ?, ?, ?)`,
		)
		.run(added.destination.id, liveHash, Date.now() + 60_000)

	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual({
		ok: true,
		userId: 1,
		email: 'phone@example.com',
	})
	expect(
		sqlite
			.prepare(
				`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations
				 WHERE id = ?`,
			)
			.get(added.destination.id) as { verified: number },
	).toEqual({ verified: 1 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get() as { count: number },
	).toEqual({ count: 0 })
})
