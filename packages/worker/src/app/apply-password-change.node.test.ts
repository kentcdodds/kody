import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createDb } from '#worker/db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { applyPasswordChange } from './apply-password-change.ts'

async function seedUserWithFactors() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const email = 'factors@example.com'
	const passwordHash = await createPasswordHash('old-password-ok')
	const stableUserId = await createStableUserIdFromEmail(email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1, 'factors', ${quoteSqlString(email)}, ${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)}, CURRENT_TIMESTAMP
		);
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'factors-github', 1, 'factors');
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (1, 'token-hash', ${Date.now() + 60_000});
	`)
	const d1 = createD1FromSqlite(sqlite)
	return { sqlite, d1, db: createDb(d1), stableUserId, passwordHash }
}

const helpers = {
	listUserGrants: async () => ({ items: [] }),
	revokeGrant: async () => {},
} as never

test('a failed factor cleanup leaves the password, stamp, and reset token untouched', async () => {
	const { sqlite, d1, db, stableUserId, passwordHash } =
		await seedUserWithFactors()
	// Force the connection delete inside clearSecondFactorsAndConnections to
	// throw so the ordering guarantee is observable.
	sqlite.exec(`DROP TABLE oauth_connections`)

	await expect(
		applyPasswordChange({
			db,
			d1,
			helpers,
			userId: 1,
			stableUserId,
			password: 'brand-new-password',
			clearSecondFactorsAndConnections: true,
		}),
	).rejects.toThrow()

	const row = sqlite
		.prepare(
			`SELECT password_hash, password_changed_at FROM users WHERE id = 1`,
		)
		.get() as { password_hash: string; password_changed_at: string | null }
	expect(row.password_hash).toBe(passwordHash)
	expect(row.password_changed_at).toBeNull()
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM password_resets`).get(),
	).toEqual({ count: 1 })
})

test('factors are cleared before password_changed_at is stamped', async () => {
	const { sqlite, d1, db, stableUserId } = await seedUserWithFactors()
	let connectionsAtStamp: number | null = null
	// Observe the connection count at the moment the users row is stamped.
	sqlite.exec(`
		CREATE TABLE stamp_markers (connections INTEGER NOT NULL);
		CREATE TRIGGER capture_connections_at_stamp
		AFTER UPDATE OF password_changed_at ON users
		BEGIN
			INSERT INTO stamp_markers (connections)
			SELECT COUNT(*) FROM oauth_connections;
		END;
	`)

	const result = await applyPasswordChange({
		db,
		d1,
		helpers,
		userId: 1,
		stableUserId,
		password: 'brand-new-password',
		clearSecondFactorsAndConnections: true,
	})
	expect(result.ok).toBe(true)

	const marker = sqlite
		.prepare(`SELECT connections FROM stamp_markers`)
		.get() as { connections: number } | undefined
	connectionsAtStamp = marker?.connections ?? null
	expect(connectionsAtStamp).toBe(0)
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM password_resets WHERE user_id = 1`,
			)
			.get(),
	).toEqual({ count: 0 })
})
