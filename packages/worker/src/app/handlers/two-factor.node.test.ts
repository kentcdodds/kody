import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { generateTOTP } from '@epic-web/totp'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { confirmTwoFactorSetup } from '#app/two-factor.ts'
import { createAccountTwoFactorApiHandler } from '#app/handlers/account-two-factor.ts'
import { createTwoFactorVerifyApiHandler } from '#app/handlers/verify.ts'
import { setVerifySessionSecret } from '#app/verify-session.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
}

function createD1FromSqlite(db: DatabaseSync) {
	function createPreparedStatement(query: string) {
		return {
			query,
			bind(...params: Array<unknown>) {
				return {
					query,
					async all<T>() {
						const statement = db.prepare(query)
						const rows = statement.all(...params) as Array<T>
						return {
							results: rows,
							meta: { changes: 0, last_row_id: 0 },
						}
					},
					async first<T>() {
						const statement = db.prepare(query)
						return (statement.get(...params) ?? null) as T | null
					},
					async run() {
						const statement = db.prepare(query)
						const result = statement.run(...params)
						return {
							meta: {
								changes: result.changes,
								last_row_id: Number(result.lastInsertRowid),
							},
						}
					},
				}
			},
			async all<T>() {
				const statement = db.prepare(query)
				const rows = statement.all() as Array<T>
				return {
					results: rows,
					meta: { changes: 0, last_row_id: 0 },
				}
			},
			async first<T>() {
				const statement = db.prepare(query)
				return (statement.get() ?? null) as T | null
			},
			async run() {
				const statement = db.prepare(query)
				const result = statement.run()
				return {
					meta: {
						changes: result.changes,
						last_row_id: Number(result.lastInsertRowid),
					},
				}
			},
		}
	}
	return {
		prepare: createPreparedStatement,
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			db.exec('BEGIN')
			try {
				for (const statement of statements) {
					results.push(await statement.run())
				}
				db.exec('COMMIT')
				return results
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
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
		password: string
	},
) {
	const passwordHash = await createPasswordHash(input.password)
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
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAccountTwoFactorApiHandler>[0]
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(
	handler: Handler,
	request: Request,
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

async function createTwoFactorApiRequest(input: {
	session: AuthSession
	body: Record<string, unknown>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/two-factor.json', {
		method: 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(input.body),
	})
}

function readVerificationRow(sqlite: DatabaseSync, target: string) {
	return sqlite
		.prepare(
			`SELECT type, secret, algorithm, digits, period, char_set
			 FROM verifications WHERE target = ?`,
		)
		.get(target) as
		| {
				type: string
				secret: string
				algorithm: string
				digits: number
				period: number
				char_set: string
		  }
		| undefined
}

async function generateCurrentCode(row: {
	secret: string
	algorithm: string
	digits: number
	period: number
	char_set: string
}) {
	const { otp } = await generateTOTP({
		secret: row.secret,
		algorithm: row.algorithm,
		digits: row.digits,
		period: row.period,
		charSet: row.char_set,
	})
	return otp
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
	setVerifySessionSecret(testCookieSecret)
})

const session: AuthSession = {
	id: '1',
	email: 'kody@example.com',
	rememberMe: false,
}

async function seedPrimaryUser(sqlite: DatabaseSync) {
	await seedUser(sqlite, {
		id: 1,
		email: 'kody@example.com',
		username: 'kody',
		password: 'ilikecode',
	})
}

test('two-factor setup requires a valid code before activating', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	const setupResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	expect(setupResponse.status).toBe(200)
	const setupPayload = (await setupResponse.json()) as {
		ok: boolean
		otpUri: string
		secret: string
	}
	expect(setupPayload.ok).toBe(true)
	expect(setupPayload.otpUri).toContain('otpauth://totp/')
	expect(setupPayload.otpUri).toContain(setupPayload.secret)

	const pendingRow = readVerificationRow(sqlite, '1')
	expect(pendingRow).toMatchObject({
		type: '2fa-verify',
		secret: setupPayload.secret,
	})

	const invalidResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: '000000' },
		}),
	)
	expect(invalidResponse.status).toBe(400)
	expect(readVerificationRow(sqlite, '1')?.type).toBe('2fa-verify')

	const validCode = await generateCurrentCode(pendingRow!)
	const confirmResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: validCode },
		}),
	)
	expect(confirmResponse.status).toBe(200)
	expect(await confirmResponse.json()).toEqual({ ok: true, enabled: true })
	// The row is promoted in place: the scanned secret stays the active one.
	expect(readVerificationRow(sqlite, '1')).toMatchObject({
		type: '2fa',
		secret: setupPayload.secret,
	})
})

test('cancelling a pending setup removes it without touching active 2fa', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const cancelResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'cancel' } }),
	)
	expect(cancelResponse.status).toBe(200)
	expect(await cancelResponse.json()).toEqual({ ok: true, enabled: false })
	expect(readVerificationRow(sqlite, '1')).toBeUndefined()
})

test('login with 2fa enabled defers the session cookie to code verification', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const appEnv = createAppEnv(db)
	const twoFactorHandler = createAccountTwoFactorApiHandler(appEnv)

	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const verificationRow = readVerificationRow(sqlite, '1')!
	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'confirm',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)

	const authHandler = createAuthHandler(
		appEnv as unknown as Parameters<typeof createAuthHandler>[0],
	)
	const loginResponse = await runHandler(
		authHandler,
		new Request('http://example.com/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: 'kody@example.com',
				password: 'ilikecode',
				mode: 'login',
			}),
		}),
	)
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({
		ok: true,
		mode: 'login',
		requiresTwoFactor: true,
	})
	const loginSetCookies = loginResponse.headers.getSetCookie()
	const pendingCookie = loginSetCookies.find((cookie) =>
		cookie.startsWith('kody_verify='),
	)
	expect(pendingCookie).toBeDefined()
	// Any pre-existing session is cleared while the second factor is pending.
	expect(
		loginSetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && cookie.includes('Max-Age=0'),
		),
	).toBe(true)
	expect(
		loginSetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
		),
	).toBe(false)

	const verifyHandler = createTwoFactorVerifyApiHandler(appEnv)
	const verifyCookieValue = pendingCookie?.split(';')[0] ?? ''

	const invalidVerifyResponse = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: {
				Cookie: verifyCookieValue,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ code: '000000' }),
		}),
	)
	expect(invalidVerifyResponse.status).toBe(400)
	expect(invalidVerifyResponse.headers.get('Set-Cookie')).toBeNull()

	const validVerifyResponse = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: {
				Cookie: verifyCookieValue,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				code: await generateCurrentCode(verificationRow),
			}),
		}),
	)
	expect(validVerifyResponse.status).toBe(200)
	expect(await validVerifyResponse.json()).toEqual({ ok: true })
	const verifySetCookies = validVerifyResponse.headers.getSetCookie()
	expect(
		verifySetCookies.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)
	expect(
		verifySetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_verify=') && cookie.includes('Max-Age=0'),
		),
	).toBe(true)
})

test('verify endpoint rejects requests without a pending session', async () => {
	const { db } = createMigratedDb()
	const verifyHandler = createTwoFactorVerifyApiHandler(createAppEnv(db))

	const response = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: '123456' }),
		}),
	)
	expect(response.status).toBe(401)
	expect(await response.json()).toMatchObject({ ok: false, code: 'expired' })
})

test('login without 2fa still issues the session cookie directly', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const authHandler = createAuthHandler(
		createAppEnv(db) as unknown as Parameters<typeof createAuthHandler>[0],
	)

	const loginResponse = await runHandler(
		authHandler,
		new Request('http://example.com/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: 'kody@example.com',
				password: 'ilikecode',
				mode: 'login',
			}),
		}),
	)
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({ ok: true, mode: 'login' })
	expect(loginResponse.headers.get('Set-Cookie')).toContain('kody_session=')
})

test('disabling 2fa requires a valid current code', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const verificationRow = readVerificationRow(sqlite, '1')!
	await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'confirm',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)

	const invalidDisable = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'disable', code: '000000' },
		}),
	)
	expect(invalidDisable.status).toBe(400)
	expect(readVerificationRow(sqlite, '1')?.type).toBe('2fa')

	const validDisable = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'disable',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)
	expect(validDisable.status).toBe(200)
	expect(await validDisable.json()).toEqual({ ok: true, enabled: false })
	expect(readVerificationRow(sqlite, '1')).toBeUndefined()
})

test('disabling 2fa also clears a pending re-setup', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const activeRow = readVerificationRow(sqlite, '1')!
	await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: await generateCurrentCode(activeRow) },
		}),
	)
	// Re-setup via the API is blocked while 2fa is active, so simulate a
	// stale pending row (e.g. left over from before enabling) directly.
	sqlite.exec(`
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set, expires_at
		) VALUES ('2fa-verify', '1', 'STALESECRET', 'SHA-1', 6, 30, '0123456789', NULL);
	`)
	const rowCountBefore = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM verifications WHERE target = '1'`)
		.get() as { count: number }
	expect(rowCountBefore.count).toBe(2)

	const disableResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'disable',
				code: await generateCurrentCode(activeRow),
			},
		}),
	)
	expect(disableResponse.status).toBe(200)
	const rowCountAfter = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM verifications WHERE target = '1'`)
		.get() as { count: number }
	expect(rowCountAfter.count).toBe(0)
})

test('setup and confirm are rejected while 2fa is already enabled', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const activeRow = readVerificationRow(sqlite, '1')!
	await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: await generateCurrentCode(activeRow) },
		}),
	)

	// A hijacked session must not be able to swap out the active factor.
	const setupResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	expect(setupResponse.status).toBe(400)

	const confirmResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: await generateCurrentCode(activeRow) },
		}),
	)
	expect(confirmResponse.status).toBe(400)
	// The active secret is untouched.
	expect(readVerificationRow(sqlite, '1')).toMatchObject({
		type: '2fa',
		secret: activeRow.secret,
	})
})

test('a duplicate confirm cannot delete the active factor', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedPrimaryUser(sqlite)
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const pendingRow = readVerificationRow(sqlite, '1')!

	// Simulates two racing confirm requests that both passed the code check:
	// the first promotes, the second must be a no-op rather than deleting the
	// freshly-activated row.
	expect(await confirmTwoFactorSetup(db, 1)).toBe(true)
	expect(await confirmTwoFactorSetup(db, 1)).toBe(false)
	expect(readVerificationRow(sqlite, '1')).toMatchObject({
		type: '2fa',
		secret: pendingRow.secret,
	})
})

test('two-factor endpoints require authentication', async () => {
	const { db } = createMigratedDb()
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	const response = await runHandler(
		handler,
		new Request('http://example.com/account/two-factor.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent: 'setup' }),
		}),
	)
	expect(response.status).toBe(401)
})
