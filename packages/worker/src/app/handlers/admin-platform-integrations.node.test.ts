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

test('admin save and delete return HTTP shapes without echoing secrets', async () => {
	const { sqlite, env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)
	const url = new URL('https://example.com/admin/platform-integrations.json')
	const invoke = (body: Record<string, unknown>) =>
		handler.handler({
			request: postRequest(body),
			url,
			params: {},
		} as never)

	const created = await invoke(saveGithubBody)
	expect(created.status).toBe(200)
	const createdPayload = await created.json()
	expect(createdPayload.apps[0]).toMatchObject({
		slug: 'github',
		hasClientSecret: true,
	})
	expect(JSON.stringify(createdPayload)).not.toContain(
		'platform-github-client-secret-value',
	)

	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, access_token_secret_name
			) VALUES (?, ?, NULL, ?, ?)`,
		)
		.run('user-1', 'github', 'github', 'githubAccessToken')

	const blocked = await invoke({ action: 'delete', slug: 'github' })
	expect(blocked.status).toBe(400)
	await expect(blocked.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('still has 1 user connection'),
	})

	sqlite.prepare('DELETE FROM user_integrations').run()
	const deleted = await invoke({ action: 'delete', slug: 'github' })
	expect(deleted.status).toBe(200)
	await expect(deleted.json()).resolves.toMatchObject({ apps: [] })
})

test('save with newSlug renames in place, keeping the secret and connections', async () => {
	const { sqlite, env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminPlatformIntegrationsApiHandler(env)
	const url = new URL('https://example.com/admin/platform-integrations.json')
	const invoke = (body: Record<string, unknown>) =>
		handler.handler({
			request: postRequest(body),
			url,
			params: {},
		} as never)

	await invoke(saveGithubBody)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, access_token_secret_name
			) VALUES (?, ?, NULL, ?, ?)`,
		)
		.run('user-1', 'github', 'github', 'githubAccessToken')

	// Rename plus a same-call edit; clientSecret omitted → retained.
	const renamed = await invoke({
		action: 'save',
		slug: 'github',
		newSlug: 'github-platform',
		clientId: saveGithubBody.clientId,
		tokenUrl: saveGithubBody.tokenUrl,
		authorizeUrl: saveGithubBody.authorizeUrl,
		flow: 'confidential',
		label: 'GitHub',
	})
	expect(renamed.status).toBe(200)
	const payload = await renamed.json()
	expect(payload.apps.map((app: { slug: string }) => app.slug)).toEqual([
		'github-platform',
	])
	expect(payload.apps[0]).toMatchObject({
		slug: 'github-platform',
		label: 'GitHub',
		hasClientSecret: true,
		connectionCount: 1,
	})
	// The connection moved lanes-intact: same name, new app reference.
	expect(
		sqlite
			.prepare(`SELECT name, platform_app_slug FROM user_integrations`)
			.get(),
	).toEqual({ name: 'github', platform_app_slug: 'github-platform' })

	// Renaming onto an occupied slug is a clean 400.
	await invoke({ ...saveGithubBody, slug: 'occupied' })
	const collision = await invoke({
		action: 'save',
		slug: 'github-platform',
		newSlug: 'occupied',
		clientId: saveGithubBody.clientId,
		tokenUrl: saveGithubBody.tokenUrl,
		authorizeUrl: saveGithubBody.authorizeUrl,
		flow: 'confidential',
	})
	expect(collision.status).toBe(400)
	await expect(collision.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('already exists'),
	})

	// A case-only slug edit is not a rename: the save applies normally.
	const caseOnly = await invoke({
		action: 'save',
		slug: 'github-platform',
		newSlug: 'GitHub-Platform',
		clientId: saveGithubBody.clientId,
		tokenUrl: saveGithubBody.tokenUrl,
		authorizeUrl: saveGithubBody.authorizeUrl,
		flow: 'confidential',
		label: 'GitHub (case-only edit)',
	})
	expect(caseOnly.status).toBe(200)
	const caseOnlyPayload = await caseOnly.json()
	expect(
		caseOnlyPayload.apps.find(
			(app: { slug: string }) => app.slug === 'github-platform',
		)?.label,
	).toBe('GitHub (case-only edit)')

	// When the post-rename upsert rejects, the rename rolls back so the row
	// never sticks under a half-applied slug.
	const failedEdit = await invoke({
		action: 'save',
		slug: 'github-platform',
		newSlug: 'github-hosted',
		clientId: saveGithubBody.clientId,
		tokenUrl: saveGithubBody.tokenUrl,
		authorizeUrl: saveGithubBody.authorizeUrl,
		flow: 'confidential',
		// Explicit null clears the stored secret while enabled → rejected.
		clientSecret: null,
		enabled: true,
	})
	expect(failedEdit.status).toBe(400)
	const after = await invoke({
		action: 'save',
		slug: 'github-platform',
		clientId: saveGithubBody.clientId,
		tokenUrl: saveGithubBody.tokenUrl,
		authorizeUrl: saveGithubBody.authorizeUrl,
		flow: 'confidential',
	})
	const slugs = (await after.json()).apps.map(
		(app: { slug: string }) => app.slug,
	)
	expect(slugs).toContain('github-platform')
	expect(slugs).not.toContain('github-hosted')
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
