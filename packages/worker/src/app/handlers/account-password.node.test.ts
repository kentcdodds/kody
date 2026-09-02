import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	readParsedAuthSession,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountPasswordHandler } from './account-password.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		password?: string
		passwordHash?: string
	},
) {
	const passwordHash =
		input.passwordHash ?? (await createPasswordHash(input.password ?? ''))
	const stableUserId = await createStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (
			id,
			username,
			email,
			stable_user_id,
			password_hash,
			email_verified_at
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

function createTrackingGrantHelpers() {
	const revokedGrantIds = new Array<string>()
	return {
		revokedGrantIds,
		helpers: {
			listUserGrants: vi.fn(async () => ({
				items: revokedGrantIds.includes('grant-1')
					? []
					: [{ id: 'grant-1', clientId: 'client-a' }],
			})),
			revokeGrant: vi.fn(async (grantId: string) => {
				revokedGrantIds.push(grantId)
			}),
		},
	}
}

function createAppEnv(db: D1Database, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Env
}

async function createRequest(input: { session: AuthSession; body: unknown }) {
	const cookie = await createAuthCookie(input.session, false)
	return {
		cookie,
		request: new Request('http://example.com/account/password.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(input.body),
		}),
	}
}

async function runHandler(
	handler: ReturnType<typeof createAccountPasswordHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('signed-in password change requires the current password, revokes MCP grants, and keeps this session', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'ada@example.com'
	await seedUser(sqlite, {
		id: 1,
		email,
		username: 'ada',
		password: 'correct-password',
	})
	sqlite.exec(`
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (1, 'pending-reset', ${Date.now() + 60_000});
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set
		) VALUES ('2fa', '1', 'KEEPSECRET', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name
		) VALUES (
			'keep-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj',
			1, 'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', 'laptop'
		);
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'keep-github', 1, 'ada');
	`)
	const { helpers, revokedGrantIds } = createTrackingGrantHelpers()
	const handler = createAccountPasswordHandler(
		createAppEnv(db, { OAUTH_PROVIDER: helpers }),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail(email),
		email,
		rememberMe: true,
	}

	const unauthenticated = await handler.handler({
		request: new Request('http://example.com/account/password.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				currentPassword: 'correct-password',
				newPassword: 'brand-new-password',
			}),
		}),
		url: new URL('http://example.com/account/password.json'),
		params: {},
	} as never)
	expect(unauthenticated.status).toBe(401)

	const wrongPassword = await runHandler(
		handler,
		(
			await createRequest({
				session,
				body: {
					currentPassword: 'wrong-password',
					newPassword: 'brand-new-password',
				},
			})
		).request,
	)
	expect(wrongPassword.status).toBe(401)
	expect(await wrongPassword.json()).toEqual({
		ok: false,
		code: 'invalid_password',
		error: 'Current password is incorrect.',
	})

	const weakPassword = await runHandler(
		handler,
		(
			await createRequest({
				session,
				body: { currentPassword: 'correct-password', newPassword: 'short' },
			})
		).request,
	)
	expect(weakPassword.status).toBe(400)
	expect(await weakPassword.json()).toMatchObject({
		ok: false,
		error: 'Password must be at least 8 characters.',
	})

	const samePassword = await runHandler(
		handler,
		(
			await createRequest({
				session,
				body: {
					currentPassword: 'correct-password',
					newPassword: 'correct-password',
				},
			})
		).request,
	)
	expect(samePassword.status).toBe(400)
	expect(await samePassword.json()).toEqual({
		ok: false,
		error: 'Choose a different password.',
	})

	const { cookie: oldCookie, request } = await createRequest({
		session,
		body: {
			currentPassword: 'correct-password',
			newPassword: 'brand-new-password',
		},
	})
	const oldSession = await readParsedAuthSession(
		new Request('http://example.com/account', {
			headers: { Cookie: oldCookie },
		}),
	)
	const response = await runHandler(handler, request)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		ok: boolean
		message: string
	}
	expect(payload.ok).toBe(true)
	expect(payload.message).toContain('Password updated.')
	expect(revokedGrantIds).toEqual(['grant-1'])
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM password_resets`).get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM verifications WHERE target = '1'`)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM passkeys WHERE user_id = 1`)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 1`,
			)
			.get(),
	).toEqual({ count: 1 })

	const row = sqlite
		.prepare(
			`SELECT password_hash, password_changed_at FROM users WHERE id = 1`,
		)
		.get() as { password_hash: string; password_changed_at: string }
	expect(await verifyPassword('brand-new-password', row.password_hash)).toBe(
		true,
	)
	expect(await verifyPassword('correct-password', row.password_hash)).toBe(
		false,
	)

	const setCookie = response.headers.get('Set-Cookie')
	expect(setCookie).toContain('kody_session=')
	const newSession = await readParsedAuthSession(
		new Request('http://example.com/account', {
			headers: { Cookie: setCookie?.split(';', 1)[0] ?? '' },
		}),
	)
	expect(newSession?.session.rememberMe).toBe(true)
	expect(
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: oldSession?.issuedAt,
			storedPasswordChangedAt: row.password_changed_at,
		}),
	).toBe(true)
	expect(
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: newSession?.issuedAt,
			storedPasswordChangedAt: row.password_changed_at,
		}),
	).toBe(false)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_change',
			result: 'success',
		}),
	)
})

test('oauth-only accounts can set a first password without a current password', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'oauth@example.com'
	await seedUser(sqlite, {
		id: 2,
		email,
		username: 'oauth-user',
		passwordHash: 'oauth_created_no_usable_password',
	})
	const { helpers } = createTrackingGrantHelpers()
	const handler = createAccountPasswordHandler(
		createAppEnv(db, { OAUTH_PROVIDER: helpers }),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail(email),
		email,
		rememberMe: false,
	}

	const missingNewPassword = await runHandler(
		handler,
		(
			await createRequest({
				session,
				body: {},
			})
		).request,
	)
	expect(missingNewPassword.status).toBe(400)

	const response = await runHandler(
		handler,
		(
			await createRequest({
				session,
				body: { newPassword: 'first-password-ok' },
			})
		).request,
	)
	expect(response.status).toBe(200)
	const row = sqlite
		.prepare(`SELECT password_hash FROM users WHERE id = 2`)
		.get() as { password_hash: string }
	expect(await verifyPassword('first-password-ok', row.password_hash)).toBe(
		true,
	)
	expect(response.headers.get('Set-Cookie')).toContain('kody_session=')
})
