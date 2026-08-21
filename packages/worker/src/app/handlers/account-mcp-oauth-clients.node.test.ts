import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountMcpOauthClientsApiHandler } from '#app/handlers/account-mcp-oauth-clients.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string; verified?: boolean },
) {
	const passwordHash = await createPasswordHash('test-password')
	const stableUserId = await createStableUserIdFromEmail(input.email)
	const verifiedSql = input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			${verifiedSql}
		);
	`)
}

function createAppEnv(
	db: D1Database,
	helpers?: {
		createClient: ReturnType<typeof vi.fn>
		deleteClient: ReturnType<typeof vi.fn>
	},
) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		OAUTH_PROVIDER: helpers,
	} as unknown as Parameters<typeof createAccountMcpOauthClientsApiHandler>[0]
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(handler: Handler, request: Request) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

const userOneSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('one@example.com'),
	email: 'one@example.com',
	rememberMe: false,
}

test('account MCP OAuth clients API mints, lists without the secret, isolates users, and gates auth', async () => {
	setAuthSessionSecret(testCookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	await seedUser(sqlite, { id: 1, email: 'one@example.com', username: 'one' })
	await seedUser(sqlite, { id: 2, email: 'two@example.com', username: 'two' })

	const helpers = {
		createClient: vi.fn(async () => ({
			clientId: 'client-one',
			clientSecret: 'shown-once',
		})),
		deleteClient: vi.fn(async () => undefined),
	}
	const handler = createAccountMcpOauthClientsApiHandler(
		createAppEnv(db, helpers),
	)
	const cookie = await createAuthCookie(userOneSession, false)

	const anonymous = await runHandler(
		handler,
		new Request('http://example.com/account/mcp-oauth-clients.json'),
	)
	expect(anonymous.status).toBe(401)

	const created = await runHandler(
		handler,
		new Request('http://example.com/account/mcp-oauth-clients.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'create',
				label: 'Open WebUI',
				redirectUris: 'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback',
			}),
		}),
	)
	expect(created.status).toBe(200)
	const createdPayload = (await created.json()) as {
		ok: boolean
		clients: Array<{ id: string; clientId: string }>
		createdClient: { clientId: string; clientSecret: string }
	}
	expect(createdPayload.ok).toBe(true)
	expect(createdPayload.createdClient).toEqual(
		expect.objectContaining({
			clientId: 'client-one',
			clientSecret: 'shown-once',
		}),
	)
	const createdId = createdPayload.clients[0]?.id
	expect(createdId).toBeTruthy()

	const listed = await runHandler(
		handler,
		new Request('http://example.com/account/mcp-oauth-clients.json', {
			headers: { Cookie: cookie },
		}),
	)
	const listedPayload = (await listed.json()) as {
		ok: boolean
		clients: Array<{ clientId: string; clientSecret?: string }>
		createdClient?: unknown
	}
	expect(listedPayload.ok).toBe(true)
	expect(listedPayload.createdClient).toBeUndefined()
	expect(listedPayload.clients.map((client) => client.clientId)).toEqual([
		'client-one',
	])
	expect(listedPayload.clients[0]).not.toHaveProperty('clientSecret')

	const otherSession: AuthSession = {
		stableUserId: testStableUserIdFromEmail('two@example.com'),
		email: 'two@example.com',
		rememberMe: false,
	}
	const otherList = await runHandler(
		handler,
		new Request('http://example.com/account/mcp-oauth-clients.json', {
			headers: {
				Cookie: await createAuthCookie(otherSession, false),
			},
		}),
	)
	const otherPayload = (await otherList.json()) as {
		clients: Array<unknown>
	}
	expect(otherPayload.clients).toEqual([])

	const revoked = await runHandler(
		handler,
		new Request('http://example.com/account/mcp-oauth-clients.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'revoke',
				id: createdId,
			}),
		}),
	)
	expect(revoked.status).toBe(200)
	expect(helpers.deleteClient).toHaveBeenCalledWith('client-one')
	const revokedPayload = (await revoked.json()) as {
		clients: Array<{ revokedAt: string | null }>
	}
	expect(revokedPayload.clients[0]?.revokedAt).toBeTruthy()

	const unverifiedSqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		unverifiedSqlite,
		new URL('../../../migrations/', import.meta.url),
	)
	const unverifiedDb = createD1FromSqlite(unverifiedSqlite)
	await seedUser(unverifiedSqlite, {
		id: 1,
		email: 'one@example.com',
		username: 'one',
		verified: false,
	})
	const unverified = await runHandler(
		createAccountMcpOauthClientsApiHandler(
			createAppEnv(unverifiedDb, {
				createClient: vi.fn(),
				deleteClient: vi.fn(),
			}),
		),
		new Request('http://example.com/account/mcp-oauth-clients.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'create',
				label: 'Open WebUI',
				redirectUris: 'https://example.com/callback',
			}),
		}),
	)
	expect(unverified.status).toBe(403)
})
