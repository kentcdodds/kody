import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountPasskeysApiHandler } from '#app/handlers/account-passkeys.ts'
import {
	createWebauthnAuthenticationHandler,
	createWebauthnRegistrationHandler,
} from '#app/handlers/webauthn.ts'
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
	},
) {
	const passwordHash = await createPasswordHash('test-password')
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

function seedPasskey(
	sqlite: DatabaseSync,
	input: { id: string; userId: number },
) {
	sqlite.exec(`
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports
		) VALUES (
			${quoteSqlString(input.id)},
			'00000000-0000-0000-0000-000000000000',
			'cHVibGljLWtleQ',
			${input.userId},
			'd2ViYXV0aG4tdXNlcg',
			0,
			'multiDevice',
			1,
			'internal'
		);
	`)
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAccountPasskeysApiHandler>[0]
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

function initTestSecrets() {
	setAuthSessionSecret(testCookieSecret)
}

const userOneSession: AuthSession = {
	id: '1',
	email: 'one@example.com',
	rememberMe: false,
}

test('account passkeys API lists owned keys and deletes them while ignoring other users', async () => {
	initTestSecrets()
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, { id: 1, email: 'one@example.com', username: 'one' })
	await seedUser(sqlite, { id: 2, email: 'two@example.com', username: 'two' })
	seedPasskey(sqlite, { id: 'passkey-user-1', userId: 1 })
	seedPasskey(sqlite, { id: 'passkey-user-2', userId: 2 })

	const handler = createAccountPasskeysApiHandler(createAppEnv(db))
	const listResponse = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			headers: { Cookie: await createAuthCookie(userOneSession, false) },
		}),
	)
	expect(listResponse.status).toBe(200)
	const listPayload = (await listResponse.json()) as {
		ok: boolean
		passkeys: Array<{ id: string }>
	}
	expect(listPayload.ok).toBe(true)
	expect(listPayload.passkeys.map((passkey) => passkey.id)).toEqual([
		'passkey-user-1',
	])

	const crossUserDelete = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'delete', passkeyId: 'passkey-user-2' }),
		}),
	)
	expect(crossUserDelete.status).toBe(404)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM passkeys`).get(),
	).toEqual({ count: 2 })

	const ownDelete = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'delete', passkeyId: 'passkey-user-1' }),
		}),
	)
	expect(ownDelete.status).toBe(200)
	expect(await ownDelete.json()).toEqual({ ok: true, passkeys: [] })
})

test('registration options require authentication and exclude existing credentials', async () => {
	initTestSecrets()
	const { sqlite, db } = createMigratedDb()
	const handler = createWebauthnRegistrationHandler(createAppEnv(db))

	const unauthenticated = await runHandler(
		handler,
		new Request('http://example.com/webauthn/registration'),
	)
	expect(unauthenticated.status).toBe(401)

	await seedUser(sqlite, { id: 1, email: 'one@example.com', username: 'one' })
	seedPasskey(sqlite, { id: 'passkey-user-1', userId: 1 })

	const response = await runHandler(
		handler,
		new Request('http://example.com/webauthn/registration', {
			headers: { Cookie: await createAuthCookie(userOneSession, false) },
		}),
	)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		ok: boolean
		options: {
			challenge: string
			rp: { id: string }
			excludeCredentials: Array<{ id: string }>
		}
	}
	expect(payload.ok).toBe(true)
	expect(payload.options.rp.id).toBe('example.com')
	expect(payload.options.challenge.length).toBeGreaterThan(0)
	expect(payload.options.excludeCredentials).toEqual([
		expect.objectContaining({ id: 'passkey-user-1' }),
	])
	expect(response.headers.get('Set-Cookie')).toContain(
		'kody_webauthn_challenge=',
	)
})

test('authentication issues challenge options and rejects unknown passkeys', async () => {
	initTestSecrets()
	const { db } = createMigratedDb()
	const handler = createWebauthnAuthenticationHandler(createAppEnv(db))
	const optionsResponse = await runHandler(
		handler,
		new Request('http://example.com/webauthn/authentication'),
	)
	expect(optionsResponse.status).toBe(200)
	const optionsPayload = (await optionsResponse.json()) as {
		ok: boolean
		options: { challenge: string }
	}
	expect(optionsPayload.ok).toBe(true)
	expect(optionsPayload.options.challenge.length).toBeGreaterThan(0)
	const challengeCookie =
		optionsResponse.headers.get('Set-Cookie')?.split(';')[0] ?? ''
	expect(challengeCookie).toContain('kody_webauthn_challenge=')

	const response = await runHandler(
		handler,
		new Request('http://example.com/webauthn/authentication', {
			method: 'POST',
			headers: {
				Cookie: challengeCookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				response: { id: 'unknown-passkey', rawId: 'unknown-passkey' },
			}),
		}),
	)
	expect(response.status).toBe(401)
	expect(await response.json()).toMatchObject({ ok: false })
})
