import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	decryptMcpServerOAuthClientSecret,
	mcpServerOAuthClientSecretContext,
} from '#mcp/secrets/crypto.ts'
import type * as HubClient from '#worker/mcp-client/hub-client.ts'
import { type SealedMcpPreRegisteredOAuthClient } from '#worker/mcp-client/preregistered-oauth-client.ts'
import { type McpServerConnectResult } from '#worker/mcp-client/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

type HubClientInput = {
	ownerId: string
	serverId: string
	callbackUrl: string
	client: SealedMcpPreRegisteredOAuthClient | null
}

const mocks = vi.hoisted(() => ({
	setPreRegisteredOAuthClient: vi.fn<
		(input: HubClientInput) => Promise<McpServerConnectResult>
	>(async (input) => ({
		serverId: input.serverId,
		state: 'authenticating',
		authorizationPending: true,
		error: null,
		toolCount: 0,
		lastError: null,
	})),
}))

vi.mock('#worker/mcp-client/hub-client.ts', async (importOriginal) => ({
	...(await importOriginal<typeof HubClient>()),
	createMcpClientHubClient: (input: { userId: string }) => ({
		setPreRegisteredOAuthClient: (
			clientInput: Omit<HubClientInput, 'ownerId'>,
		) =>
			mocks.setPreRegisteredOAuthClient({
				ownerId: input.userId,
				...clientInput,
			}),
	}),
	getCachedMcpClientHubSnapshot: async () => ({ servers: [] }),
}))

const { createAccountMcpServersApiHandler } =
	await import('./account-mcp-servers.ts')

const cookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const secretStoreKey = 'test-secret-store-key-32-chars-minimum'
const origin = 'https://kody.test'
const clientId = 'Iv1.github-app-client'
const clientSecret = 'gh-oauth-client-secret-never-echo'
const replacementSecret = 'gh-oauth-client-secret-rotated'

const people = {
	ada: { id: 1, email: 'ada@example.com' },
	bob: { id: 2, email: 'bob@example.com' },
	dan: { id: 3, email: 'dan@example.com' },
} as const
type Person = keyof typeof people

function personId(person: Person) {
	return testStableUserIdFromEmail(people[person].email)
}

const consoleCalls: Array<unknown> = []
beforeEach(() => {
	consoleCalls.length = 0
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args) => {
			consoleCalls.push(args)
		})
	}
})
afterEach(() => {
	vi.restoreAllMocks()
})

async function seed() {
	setAuthSessionSecret(cookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const passwordHash = await createPasswordHash('test-password')
	for (const [username, person] of Object.entries(people)) {
		sqlite.exec(`
			INSERT INTO users (
				id, username, email, stable_user_id, password_hash, email_verified_at
			) VALUES (
				${person.id},
				${quoteSqlString(username)},
				${quoteSqlString(person.email)},
				${quoteSqlString(testStableUserIdFromEmail(person.email))},
				${quoteSqlString(passwordHash)},
				CURRENT_TIMESTAMP
			);
		`)
		await provisionPersonalOrgForSqliteUser(sqlite, {
			stableUserId: testStableUserIdFromEmail(person.email),
			username,
		})
	}
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?, ?)`,
		)
		.run(personId('ada'), now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['dan', 'member'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(personId(person), role, now)
	}
	sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES (?, ?, ?, ?)`,
		)
		.run('server-acme', 'org-acme', 'github', 'https://api.github.example/mcp')
	mocks.setPreRegisteredOAuthClient.mockClear()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createAuditTestDb(),
		APP_BASE_URL: origin,
		COOKIE_SECRET: cookieSecret,
		SECRET_STORE_KEY: secretStoreKey,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	return { env, sqlite }
}

async function callApi(
	env: Env,
	input: {
		person: Person
		orgSlug?: string
		method?: 'GET' | 'POST'
		body?: Record<string, unknown>
	},
) {
	const orgSlug = input.orgSlug ?? 'acme'
	const cookie = await createAuthCookie(
		{
			stableUserId: personId(input.person),
			email: people[input.person].email,
			rememberMe: false,
		},
		false,
	)
	const request = new Request(`${origin}/account/mcp-servers.json`, {
		method: input.method ?? 'POST',
		headers: {
			Cookie: cookie,
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Origin: origin,
			Referer: `${origin}/@${orgSlug}/-/mcp-servers/server-acme`,
		},
		...(input.body ? { body: JSON.stringify(input.body) } : {}),
	})
	const response = await createAccountMcpServersApiHandler(env).handler({
		request,
		params: {},
		url: new URL(request.url),
	} as never)
	return { status: response.status, text: await response.text() }
}

function storedSetting(sqlite: DatabaseSync) {
	return sqlite
		.prepare(`SELECT * FROM mcp_server_settings WHERE id = 'server-acme'`)
		.get() as Record<string, unknown>
}

async function auditRows(env: Env) {
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT * FROM org_audit_events ORDER BY created_at, rowid`,
	).all<Record<string, unknown>>()
	return results ?? []
}

function hubCall(index: number) {
	const call = mocks.setPreRegisteredOAuthClient.mock.calls[index]?.[0]
	if (!call) throw new Error(`Expected hub call ${index}.`)
	return call
}

test('an org admin saves, replaces, and removes a client; only the sealed secret reaches the hub and nothing echoes it', async () => {
	const { env, sqlite } = await seed()

	const saved = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId: ` ${clientId} `,
			clientSecret,
		},
	})
	expect(saved.status).toBe(200)
	expect(saved.text).not.toContain(clientSecret)
	const savedServer = (
		JSON.parse(saved.text) as {
			servers: Array<{ id: string; oauthClientId: string | null }>
		}
	).servers.find((server) => server.id === 'server-acme')
	expect(savedServer?.oauthClientId).toBe(clientId)

	const firstCall = hubCall(0)
	expect(firstCall).toMatchObject({
		ownerId: 'org-acme',
		serverId: 'server-acme',
		callbackUrl: `${origin}/account/mcp-servers/oauth/callback`,
		client: { clientId, sealedClientSecret: expect.stringMatching(/^v2\./) },
	})
	expect(JSON.stringify(firstCall)).not.toContain(clientSecret)
	const sealed = firstCall.client?.sealedClientSecret ?? ''
	expect(
		await decryptMcpServerOAuthClientSecret(
			env,
			sealed,
			mcpServerOAuthClientSecretContext('server-acme'),
		),
	).toBe(clientSecret)
	await expect(
		decryptMcpServerOAuthClientSecret(
			env,
			sealed,
			mcpServerOAuthClientSecretContext('server-other'),
		),
	).rejects.toThrow('Unable to decrypt MCP server OAuth client secret.')

	expect(storedSetting(sqlite)['oauth_client_id']).toBe(clientId)
	expect(JSON.stringify(storedSetting(sqlite))).not.toContain(clientSecret)

	const listed = await callApi(env, { person: 'ada', method: 'GET' })
	expect(listed.status).toBe(200)
	expect(listed.text).toContain(clientId)
	expect(listed.text).not.toContain(clientSecret)

	const replaced = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId,
			clientSecret: replacementSecret,
		},
	})
	expect(replaced.status).toBe(200)
	expect(replaced.text).not.toContain(replacementSecret)

	const removed = await callApi(env, {
		person: 'ada',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(removed.status).toBe(200)
	expect(hubCall(2).client).toBeNull()
	expect(storedSetting(sqlite)['oauth_client_id']).toBeNull()

	const audit = await auditRows(env)
	expect(
		audit.map((row) => ({
			org: row['org_id'],
			action: row['action'],
			resourceType: row['resource_type'],
			resourceId: row['resource_id'],
			actor: row['actor_user_id'],
			details: JSON.parse(String(row['details_json'])),
		})),
	).toEqual([
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_set',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_replaced',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_removed',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
	])

	const everything = JSON.stringify([
		audit,
		consoleCalls,
		mocks.setPreRegisteredOAuthClient.mock.calls,
		storedSetting(sqlite),
	])
	expect(everything).not.toContain(clientSecret)
	expect(everything).not.toContain(replacementSecret)
})

test('members without integration write, people outside the org, and other orgs cannot touch the client', async () => {
	const { env, sqlite } = await seed()
	const body = {
		action: 'set-oauth-client',
		id: 'server-acme',
		clientId,
		clientSecret,
	}

	const member = await callApi(env, { person: 'dan', body })
	expect(member.status).toBe(403)

	const outsider = await callApi(env, { person: 'bob', body })
	expect(outsider.status).toBe(400)
	expect(JSON.parse(outsider.text)).toMatchObject({
		ok: false,
		error: 'MCP server not found.',
	})

	const wrongOrg = await callApi(env, { person: 'ada', orgSlug: 'ada', body })
	expect(wrongOrg.status).toBe(400)
	expect(JSON.parse(wrongOrg.text)).toMatchObject({
		ok: false,
		error: 'MCP server not found.',
	})

	const memberRemove = await callApi(env, {
		person: 'dan',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(memberRemove.status).toBe(403)

	expect(mocks.setPreRegisteredOAuthClient).not.toHaveBeenCalled()
	expect(storedSetting(sqlite)['oauth_client_id']).toBeNull()
	expect(await auditRows(env)).toEqual([])
	for (const response of [member, outsider, wrongOrg, memberRemove]) {
		expect(response.text).not.toContain(clientSecret)
	}
	expect(JSON.stringify(consoleCalls)).not.toContain(clientSecret)
})

test('incomplete input and removing a missing client are rejected before anything is written', async () => {
	const { env, sqlite } = await seed()

	const missingSecret = await callApi(env, {
		person: 'ada',
		body: { action: 'set-oauth-client', id: 'server-acme', clientId },
	})
	expect(missingSecret.status).toBe(400)
	expect(JSON.parse(missingSecret.text)).toMatchObject({
		ok: false,
		error: 'Client secret is required.',
	})

	const nothingToRemove = await callApi(env, {
		person: 'ada',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(nothingToRemove.status).toBe(400)

	expect(mocks.setPreRegisteredOAuthClient).not.toHaveBeenCalled()
	expect(storedSetting(sqlite)['oauth_client_id']).toBeNull()
	expect(await auditRows(env)).toEqual([])
})

test('a hub failure leaves the saved client id as it was and records no audit event', async () => {
	const { env, sqlite } = await seed()
	mocks.setPreRegisteredOAuthClient.mockRejectedValueOnce(
		new Error('MCP server "server-acme" is not registered.'),
	)

	const failed = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId,
			clientSecret,
		},
	})
	expect(failed.status).toBe(400)
	expect(failed.text).toContain('Unable to update the OAuth client')
	expect(failed.text).not.toContain(clientSecret)
	expect(storedSetting(sqlite)['oauth_client_id']).toBeNull()
	expect(await auditRows(env)).toEqual([])
})
