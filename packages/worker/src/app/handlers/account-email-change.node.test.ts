import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailChangeToken } from '#app/email-change.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createAccountEmailChangeHandler } from './account-email-change.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
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
		verified?: boolean
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
			${input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'}
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
	} as unknown as Parameters<typeof createAccountEmailChangeHandler>[0]
}

async function createRequest(input: {
	session: AuthSession
	email: string
	password: string
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-change.json', {
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

async function runHandler(
	handler: ReturnType<typeof createAccountEmailChangeHandler>,
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

test('email change requests require the current password and create a pending verification', async () => {
	// No email sender is configured in this test env, so the skipped
	// verification send logs a warning.
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	const handler = createAccountEmailChangeHandler(createAppEnv(db))
	const session = {
		stableUserId: testStableUserIdFromEmail('old@example.com'),
		email: 'old@example.com',
		rememberMe: false,
	}

	const wrongPasswordResponse = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'new@example.com',
			password: 'wrong-password',
		}),
	)
	expect(wrongPasswordResponse.status).toBe(401)
	expect(await wrongPasswordResponse.json()).toEqual({
		ok: false,
		code: 'invalid_password',
		error: 'Password is incorrect.',
	})
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM pending_email_changes`)
			.get() as { count: number },
	).toEqual({ count: 0 })

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'New@Example.com',
			password: 'correct-password',
		}),
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		message: 'Verification email sent to your new address.',
	})
	expect(
		sqlite
			.prepare(
				`SELECT user_id, new_email, token_hash FROM pending_email_changes`,
			)
			.get(),
	).toMatchObject({
		user_id: 1,
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})
	const firstPendingToken = (
		sqlite
			.prepare(`SELECT token_hash FROM pending_email_changes WHERE user_id = 1`)
			.get() as { token_hash: string }
	).token_hash

	const resendResponse = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'new@example.com',
			password: 'correct-password',
		}),
	)
	expect(resendResponse.status).toBe(200)
	const pendingRows = sqlite
		.prepare(`SELECT new_email, token_hash FROM pending_email_changes`)
		.all() as Array<{ new_email: string; token_hash: string }>
	expect(pendingRows).toHaveLength(1)
	expect(pendingRows[0]).toMatchObject({
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})
	expect(pendingRows[0]?.token_hash).not.toBe(firstPendingToken)
	expect(consoleWarn).toHaveBeenCalledWith('email-change-send-skipped', 1)
})

test('email change requests reject emails already owned by another account', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	await seedUser(sqlite, {
		id: 2,
		email: 'taken@example.com',
		username: 'taken-user',
		password: 'taken-password',
	})
	const handler = createAccountEmailChangeHandler(createAppEnv(db))

	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				stableUserId: testStableUserIdFromEmail('old@example.com'),
				email: 'old@example.com',
				rememberMe: false,
			},
			email: 'taken@example.com',
			password: 'correct-password',
		}),
	)
	expect(response.status).toBe(409)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Email already registered.',
	})
})

test('email change verification updates email and preserves stable user id', async () => {
	const { sqlite, db } = createMigratedDb()
	const oldStableUserId = await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
		verified: false,
	})
	const token = 'verify-email-change-token'
	const tokenHash = await hashVerificationToken(token)
	const now = new Date('2026-07-06T00:00:00.000Z')
	const expiresAt = now.getTime() + 60_000
	sqlite.exec(`
		INSERT INTO email_verifications (user_id, token_hash, expires_at)
		VALUES (1, 'old-account-token', ${expiresAt});
		INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		VALUES (1, 'new@example.com', ${quoteSqlString(tokenHash)}, ${expiresAt});
	`)

	const result = await verifyEmailChangeToken({
		db,
		token,
		now,
	})
	expect(result).toEqual({
		ok: true,
		userId: 1,
		stableUserId: oldStableUserId,
		oldEmail: 'old@example.com',
		newEmail: 'new@example.com',
	})
	expect(
		sqlite
			.prepare(
				`SELECT email, stable_user_id, email_verified_at FROM users WHERE id = 1`,
			)
			.get(),
	).toEqual({
		email: 'new@example.com',
		stable_user_id: oldStableUserId,
		email_verified_at: '2026-07-06T00:00:00.000Z',
	})
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM pending_email_changes`).get(),
	).toEqual({ count: 0 })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_verifications`).get(),
	).toEqual({ count: 0 })
})
