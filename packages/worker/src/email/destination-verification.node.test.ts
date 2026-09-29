import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { hashVerificationToken } from '#worker/identity/email-verification-tokens.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	addEmailNotificationDestination,
	type EmailDestinationError,
} from './destinations.ts'
import {
	createEmailDestinationVerification,
	emailDestinationRateLimitConfig,
	verifyEmailDestinationToken,
} from './destination-verification.ts'

async function makeOwner() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const stableUserId = await createStableUserIdFromEmail('owner@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1, 'owner', 'owner@example.com', ${quoteSqlString(stableUserId)},
			'test-password-hash', CURRENT_TIMESTAMP
		);
	`)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as Env
	return {
		sqlite,
		db,
		create: (email: string) =>
			createEmailDestinationVerification({
				env,
				userId: 1,
				email,
				requestUrl: 'http://example.com',
			}),
		pendingTokenHashes: (destinationId: string) =>
			(
				sqlite
					.prepare(
						`SELECT token_hash AS tokenHash
						 FROM pending_email_destination_verifications
						 WHERE destination_id = ?
						 ORDER BY id ASC`,
					)
					.all(destinationId) as Array<{ tokenHash: string }>
			).map((row) => row.tokenHash),
	}
}

test('destination verification tokens mark one extra address verified and reject missing/expired links', async () => {
	const { sqlite, db } = await makeOwner()
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'phone@example.com',
	})
	const insertPending = async (token: string, expiresAt: number) =>
		sqlite
			.prepare(
				`INSERT INTO pending_email_destination_verifications
				 (user_id, destination_id, token_hash, expires_at)
				 VALUES (1, ?, ?, ?)`,
			)
			.run(added.destination.id, await hashVerificationToken(token), expiresAt)
	const isVerified = () =>
		sqlite
			.prepare(
				`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations WHERE id = ?`,
			)
			.get(added.destination.id)

	const expiredToken = 'a'.repeat(64)
	await insertPending(expiredToken, Date.now() - 1)
	for (const [token, reason] of [
		['', 'missing_token'],
		['nope', 'invalid_token'],
		[expiredToken, 'expired_token'],
	] as const) {
		expect(await verifyEmailDestinationToken({ db, token })).toEqual({
			ok: false,
			reason,
		})
	}

	const liveToken = 'b'.repeat(64)
	await insertPending(liveToken, Date.now() + 60_000)
	const verifiedPhone = { ok: true, userId: 1, email: 'phone@example.com' }
	expect(
		await verifyEmailDestinationToken({ db, token: liveToken, consume: false }),
	).toEqual(verifiedPhone)
	expect(isVerified()).toEqual({ verified: 0 })

	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual(
		verifiedPhone,
	)
	expect(isVerified()).toEqual({ verified: 1 })
	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual(
		verifiedPhone,
	)
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get(),
	).toEqual({ count: 1 })
})

test('createEmailDestinationVerification rate-limits add and resend for UI and MCP', async () => {
	consoleWarn.mockImplementation(() => {})
	const { create } = await makeOwner()
	for (
		let index = 0;
		index < emailDestinationRateLimitConfig.maxRequests;
		index++
	) {
		expect((await create(`extra-${index}@example.com`)).created).toBe(true)
	}
	await expect(create('one-more@example.com')).rejects.toMatchObject({
		code: 'rate_limited',
	} satisfies Partial<EmailDestinationError>)
	expect(consoleWarn).toHaveBeenCalled()
})

test('createEmailDestinationVerification resends for a pending address and leaves unused links valid', async () => {
	consoleWarn.mockImplementation(() => {})
	const { create, pendingTokenHashes } = await makeOwner()
	const first = await create('pager@example.com')
	expect(first.created).toBe(true)
	const [firstTokenHash] = pendingTokenHashes(first.destination.id)

	expect(await create('Pager@Example.com')).toMatchObject({
		created: false,
		destination: { id: first.destination.id, email: 'pager@example.com' },
	})
	const pending = pendingTokenHashes(first.destination.id)
	expect(pending).toHaveLength(2)
	expect(pending[0]).toBe(firstTokenHash)
	expect(pending[1]).not.toBe(firstTokenHash)
})
