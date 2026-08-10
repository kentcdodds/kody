import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const { createAdminPlatformIntegrationsApiHandler } =
	await import('./admin-platform-integrations.ts')

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

function createActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: '1'.padStart(64, '0'),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const objects = new Map<string, Uint8Array>()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: {
			async put(key: string, bytes: Uint8Array) {
				objects.set(key, bytes)
			},
			async get(key: string) {
				return objects.has(key) ? { body: objects.get(key) } : null
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
	} as Env
	return { sqlite, env, objects }
}

function postRequest(body: Record<string, unknown>) {
	return new Request('https://example.com/admin/platform-integrations.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

const saveGithubBody = {
	action: 'save',
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	flow: 'confidential',
	allowedScopes: ['repo', 'read:user'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com'],
}

test('save creates an app, never echoes the secret, and partial saves retain fields', async () => {
	const { env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)

	const created = await handler.handler({
		request: postRequest(saveGithubBody),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	expect(created.status).toBe(200)
	const createdPayload = await created.json()
	expect(createdPayload.apps).toHaveLength(1)
	expect(createdPayload.apps[0]).toMatchObject({
		slug: 'github',
		hasClientSecret: true,
		enabled: true,
		defaultScopes: ['read:user'],
		connectionCount: 0,
	})
	expect(JSON.stringify(createdPayload)).not.toContain(
		'platform-github-client-secret-value',
	)

	// Partial save (disable) retains scopes, hosts, and the stored secret.
	const disabled = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'github',
			clientId: saveGithubBody.clientId,
			tokenUrl: saveGithubBody.tokenUrl,
			authorizeUrl: saveGithubBody.authorizeUrl,
			flow: 'confidential',
			enabled: false,
		}),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	const disabledPayload = await disabled.json()
	expect(disabledPayload.apps[0]).toMatchObject({
		enabled: false,
		hasClientSecret: true,
		allowedScopes: ['read:user', 'repo'],
		requiredHosts: ['api.github.com'],
	})
})

test('delete refuses while connections reference the app and succeeds after cleanup', async () => {
	const { sqlite, env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)
	await handler.handler({
		request: postRequest(saveGithubBody),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, access_token_secret_name
			) VALUES (?, ?, NULL, ?, ?)`,
		)
		.run('user-1', 'github', 'github', 'githubAccessToken')

	const blocked = await handler.handler({
		request: postRequest({ action: 'delete', slug: 'github' }),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	expect(blocked.status).toBe(400)
	await expect(blocked.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('still has 1 user connection'),
	})

	sqlite.prepare('DELETE FROM user_integrations').run()
	const deleted = await handler.handler({
		request: postRequest({ action: 'delete', slug: 'github' }),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	expect(deleted.status).toBe(200)
	await expect(deleted.json()).resolves.toMatchObject({ apps: [] })
})

test('logo uploads store an asset and clear removes it', async () => {
	const { env, objects } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)
	await handler.handler({
		request: postRequest(saveGithubBody),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)

	const tinyPngBase64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
	const uploaded = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'github',
			clientId: saveGithubBody.clientId,
			tokenUrl: saveGithubBody.tokenUrl,
			authorizeUrl: saveGithubBody.authorizeUrl,
			flow: 'confidential',
			logoBase64: tinyPngBase64,
		}),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	const uploadedPayload = await uploaded.json()
	expect(uploadedPayload.apps[0].logoPath).toMatch(
		/^\/integrations\/logos\/github\?v=/,
	)
	expect(objects.size).toBe(1)

	const cleared = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'github',
			clientId: saveGithubBody.clientId,
			tokenUrl: saveGithubBody.tokenUrl,
			authorizeUrl: saveGithubBody.authorizeUrl,
			flow: 'confidential',
			logoBase64: '',
		}),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	const clearedPayload = await cleared.json()
	expect(clearedPayload.apps[0].logoPath).toBeNull()
	expect(objects.size).toBe(0)
})

test('non-admin callers are rejected', async () => {
	const { env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['user']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)
	const response = await handler.handler({
		request: postRequest(saveGithubBody),
		url: new URL('https://example.com/admin/platform-integrations.json'),
		params: {},
	} as never)
	expect(response.status).toBe(403)
})
