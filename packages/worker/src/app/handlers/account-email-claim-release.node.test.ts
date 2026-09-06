import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { RequestContext } from 'remix/router'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailClaimReleaseToken } from '#app/email-claim-release.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { formerEmailClaimedSignupCode } from '#universal/email-claim-errors.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createAccountEmailClaimReleaseHandler } from './account-email-claim-release.ts'
import { createAuthHandler } from './auth.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		password: string
		stableUserId?: string
	},
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId =
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
	return stableUserId
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		SIGNUP_MODE: 'open',
	} as unknown as Env
}

async function createReleaseRequest(input: {
	session: AuthSession
	email: string
	password: string
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-claim-release.json', {
		method: 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: input.email,
			password: input.password,
		}),
	})
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('release re-verifies a former address then allows a new account without reminting', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	const formerEmail = 'personal@example.com'
	const currentEmail = 'work@example.com'
	const stableUserId = await seedUser(sqlite, {
		id: 1,
		email: currentEmail,
		username: 'jamie',
		password: 'correct-password',
		stableUserId: await createStableUserIdFromEmail(formerEmail),
	})
	sqlite.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, ${quoteSqlString(currentEmail)}, 'claimed');
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, ${quoteSqlString(formerEmail)}, 'claimed');
	`)

	const env = createAppEnv(db)
	const handler = createAccountEmailClaimReleaseHandler(env)
	const session = {
		stableUserId: testStableUserIdFromEmail(formerEmail),
		email: currentEmail,
		rememberMe: false,
	}

	const currentEmailResponse = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: currentEmail,
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(currentEmailResponse.status).toBe(400)

	const signupHandler = createAuthHandler(env)
	const blockedSignup = await signupHandler.handler(
		new RequestContext(
			new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: formerEmail,
					username: 'new-jamie',
					password: 'password123',
					mode: 'signup',
				}),
			}),
		),
	)
	expect(blockedSignup.status).toBe(409)
	expect(await blockedSignup.json()).toMatchObject({
		code: formerEmailClaimedSignupCode,
	})

	const requestResponse = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: formerEmail,
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(requestResponse.status).toBe(200)
	expect(await requestResponse.json()).toMatchObject({ ok: true })

	const pending = sqlite
		.prepare(
			`SELECT token_hash FROM pending_email_claim_releases WHERE user_id = 1`,
		)
		.get() as { token_hash: string }
	expect(pending.token_hash).toEqual(expect.any(String))

	const token = 'release-former-email-token'
	const tokenHash = await hashVerificationToken(token)
	sqlite.exec(`
		UPDATE pending_email_claim_releases
		SET token_hash = ${quoteSqlString(tokenHash)}
		WHERE user_id = 1
	`)

	const verified = await verifyEmailClaimReleaseToken({
		db,
		token,
	})
	expect(verified).toEqual({
		ok: true,
		userId: 1,
		email: formerEmail,
	})
	expect(
		sqlite
			.prepare(
				`SELECT status FROM user_email_claims WHERE user_id = 1 AND email = ?`,
			)
			.get(formerEmail) as { status: string },
	).toEqual({ status: 'released' })
	expect(
		sqlite.prepare(`SELECT stable_user_id FROM users WHERE id = 1`).get() as {
			stable_user_id: string
		},
	).toEqual({ stable_user_id: stableUserId })

	const allowedSignup = await signupHandler.handler(
		new RequestContext(
			new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: formerEmail,
					username: 'new-jamie',
					password: 'password123',
					mode: 'signup',
				}),
			}),
		),
	)
	expect(allowedSignup.status).toBe(200)
	const created = sqlite
		.prepare(`SELECT email, stable_user_id FROM users WHERE email = ?`)
		.get(formerEmail) as { email: string; stable_user_id: string }
	expect(created.email).toBe(formerEmail)
	expect(created.stable_user_id).not.toBe(stableUserId)
	expect(created.stable_user_id).toMatch(/^[a-f0-9]{64}$/)
})

test('release requests are rate limited and refuse another account email', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
		password: 'correct-password',
	})
	await seedUser(sqlite, {
		id: 2,
		email: 'other@example.com',
		username: 'other',
		password: 'other-password',
	})
	const handler = createAccountEmailClaimReleaseHandler(createAppEnv(db))
	const session = {
		stableUserId: testStableUserIdFromEmail('owner@example.com'),
		email: 'owner@example.com',
		rememberMe: false,
	}

	const stranger = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'other@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(stranger.status).toBe(404)

	const first = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(first.status).toBe(404)

	const second = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(second.status).toBe(404)

	const limited = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(limited.status).toBe(429)
})
