import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countConnectionsForPlatformApp,
	deletePlatformOauthApp,
	getPlatformOauthAppBySlug,
	getPlatformOauthAppClientSecret,
	listPlatformOauthApps,
	listTopPlatformAppsByUse,
	PlatformOauthAppValidationError,
	renamePlatformOauthApp,
	upsertPlatformOauthApp,
} from './platform-apps.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const githubSecret = 'platform-github-client-secret-value'

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const env = {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Pick<Env, 'SECRET_STORE_KEY'>
	const upsert = (app: Parameters<typeof upsertPlatformOauthApp>[0]['app']) =>
		upsertPlatformOauthApp({ db, env, app })
	const readSecret = (slug = 'github') =>
		getPlatformOauthAppClientSecret({ db, env, slug })
	const insertConnection = sqlite.prepare(
		`INSERT INTO user_integrations (
			user_id, name, app_slug, platform_app_slug
		) VALUES (?, ?, NULL, ?)`,
	)
	const connect = (userId: string, slug: string) =>
		insertConnection.run(userId, slug, slug)
	return { sqlite, db, env, upsert, readSecret, connect }
}

const coreGithubApp = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	flow: 'confidential' as const,
}

const baseGithubApp = {
	...coreGithubApp,
	clientSecret: githubSecret,
	apiBaseUrl: 'https://api.github.com',
	allowedScopes: ['repo', 'read:user', 'gist'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com', 'github.com'],
}

test('upsert lifecycle encrypts secrets, omits retain fields, null clears, and partial disable preserves data', async () => {
	const { sqlite, db, upsert, readSecret } = createHarness()
	await upsert({ ...baseGithubApp, description: 'Send-only Gmail, no inbox.' })
	const row = sqlite
		.prepare(
			'SELECT client_secret_encrypted FROM platform_oauth_apps WHERE slug = ?',
		)
		.get('github') as { client_secret_encrypted: string }
	expect(row.client_secret_encrypted).toBeTruthy()
	expect(row.client_secret_encrypted).not.toContain(githubSecret)
	expect(await readSecret()).toBe(githubSecret)

	const app = await getPlatformOauthAppBySlug({ db, slug: 'github' })
	expect(app).toMatchObject({
		slug: 'github',
		provider: 'github',
		hasClientSecret: true,
		enabled: true,
		description: 'Send-only Gmail, no inbox.',
	})
	expect(JSON.stringify(app)).not.toContain(githubSecret)
	expect(Object.keys(app ?? {})).not.toContain('client_secret_encrypted')

	const retained = await upsert(baseGithubApp)
	expect(retained.description).toBe('Send-only Gmail, no inbox.')
	expect(await readSecret()).toBe(githubSecret)
	await upsert({
		...baseGithubApp,
		clientSecret: undefined,
		label: 'GitHub (built-in)',
	})
	expect(await readSecret()).toBe(githubSecret)
	await upsert({ ...baseGithubApp, flow: 'pkce', clientSecret: null })
	expect(await readSecret()).toBeNull()

	await upsert({ ...baseGithubApp, description: 'Set again.' })
	const clearedDescription = await upsert({
		...baseGithubApp,
		description: null,
	})
	expect(clearedDescription.description).toBeNull()

	const disabled = await upsert({ ...coreGithubApp, enabled: false })
	expect(disabled).toMatchObject({
		enabled: false,
		allowedScopes: ['gist', 'read:user', 'repo'],
		defaultScopes: ['read:user'],
		requiredHosts: ['api.github.com', 'github.com'],
		apiBaseUrl: 'https://api.github.com',
	})
	expect(await readSecret()).toBe(githubSecret)

	const clearedFields = await upsert({
		...coreGithubApp,
		allowedScopes: [],
		defaultScopes: [],
		requiredHosts: [],
	})
	expect(clearedFields.allowedScopes).toEqual([])
	expect(clearedFields.requiredHosts).toEqual([])
})

test('confidential flow requires a client secret only while enabled', async () => {
	const { upsert } = createHarness()
	await expect(
		upsert({ ...baseGithubApp, clientSecret: null }),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)
	const staged = await upsert({
		...baseGithubApp,
		clientSecret: null,
		enabled: false,
	})
	expect(staged.enabled).toBe(false)
	expect(staged.hasClientSecret).toBe(false)
	await expect(
		upsert({ ...coreGithubApp, enabled: true }),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)
	const live = await upsert({
		...coreGithubApp,
		clientSecret: 'late-pasted-secret',
		enabled: true,
	})
	expect(live.enabled).toBe(true)
	expect(live.hasClientSecret).toBe(true)
})

test('allowedScopes always contains defaultScopes and disabled apps hide from the default list', async () => {
	const { db, upsert } = createHarness()
	await upsert({
		...baseGithubApp,
		allowedScopes: ['repo'],
		defaultScopes: ['read:user'],
		enabled: false,
	})
	const app = await getPlatformOauthAppBySlug({
		db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(app?.allowedScopes).toEqual(['read:user', 'repo'])
	expect(await listPlatformOauthApps({ db })).toEqual([])
	expect(await getPlatformOauthAppBySlug({ db, slug: 'github' })).toBeNull()
	expect(
		await listPlatformOauthApps({ db, includeDisabled: true }),
	).toHaveLength(1)
})

test('deletePlatformOauthApp refuses while user connections reference the app', async () => {
	const { sqlite, db, upsert, connect } = createHarness()
	await upsert(baseGithubApp)
	connect('user-1', 'github')
	expect(await countConnectionsForPlatformApp({ db, slug: 'github' })).toBe(1)
	await expect(deletePlatformOauthApp({ db, slug: 'github' })).rejects.toThrow(
		'still has 1 user connection',
	)
	sqlite
		.prepare('DELETE FROM user_integrations WHERE user_id = ?')
		.run('user-1')
	expect(await deletePlatformOauthApp({ db, slug: 'github' })).toBe(true)
})

test('listTopPlatformAppsByUse orders enabled apps by connection count and hides disabled', async () => {
	const { db, upsert, connect } = createHarness()
	for (const slug of ['github', 'google', 'notion', 'slack']) {
		await upsert({ ...baseGithubApp, slug, enabled: slug !== 'slack' })
	}
	for (const [userId, slug] of [
		['user-1', 'google'],
		['user-2', 'google'],
		['user-1', 'notion'],
		['user-1', 'slack'],
		['user-2', 'slack'],
		['user-3', 'slack'],
	] as const) {
		connect(userId, slug)
	}
	const topSlugs = async (limit: number) =>
		(await listTopPlatformAppsByUse({ db, limit })).map((app) => app.slug)
	expect(await topSlugs(3)).toEqual(['google', 'notion', 'github'])
	expect(await topSlugs(2)).toEqual(['google', 'notion'])
})

test('renamePlatformOauthApp carries the secret and moves connections atomically', async () => {
	const { sqlite, db, env, upsert, readSecret, connect } = createHarness()
	await upsert({ ...baseGithubApp, description: 'Kody-hosted GitHub app.' })
	sqlite
		.prepare(
			`UPDATE platform_oauth_apps SET logo_key = ?, logo_content_type = ?
			WHERE slug = ?`,
		)
		.run('platform-logos/github/abc123.png', 'image/png', 'github')
	connect('user-1', 'github')

	const rename = (slug: string, newSlug: string) =>
		renamePlatformOauthApp({ db, env, slug, newSlug })
	expect(await rename('github', 'github-platform')).toMatchObject({
		slug: 'github-platform',
		provider: 'github',
		description: 'Kody-hosted GitHub app.',
		hasClientSecret: true,
		logoKey: 'platform-logos/github/abc123.png',
	})
	// The write-only encrypted secret decrypts under the new slug.
	expect(await readSecret('github-platform')).toBe(githubSecret)
	// The old slug is gone; the connection moved but kept its name.
	expect(
		await getPlatformOauthAppBySlug({
			db,
			slug: 'github',
			includeDisabled: true,
		}),
	).toBeNull()
	expect(
		await countConnectionsForPlatformApp({ db, slug: 'github-platform' }),
	).toBe(1)
	expect(
		sqlite
			.prepare(
				`SELECT name, platform_app_slug FROM user_integrations WHERE user_id = ?`,
			)
			.get('user-1'),
	).toEqual({ name: 'github', platform_app_slug: 'github-platform' })

	// Guards: missing source, same slug, and collisions all reject.
	await expect(rename('missing', 'other')).rejects.toThrow('was not found')
	await expect(rename('github-platform', 'github-platform')).rejects.toThrow(
		'matches the current slug',
	)
	await upsert({ ...baseGithubApp, slug: 'occupied' })
	await expect(rename('github-platform', 'occupied')).rejects.toThrow(
		'already exists',
	)
})

test('user_integrations enforces exactly one of app_slug / platform_app_slug', async () => {
	const { sqlite, upsert } = createHarness()
	await upsert(baseGithubApp)
	const insert = sqlite.prepare(
		`INSERT INTO user_integrations (
			user_id, name, app_slug, platform_app_slug
		) VALUES (?, ?, ?, ?)`,
	)
	expect(() => insert.run('user-1', 'github', 'github', 'github')).toThrow(
		/CHECK/i,
	)
	expect(() => insert.run('user-1', 'github', null, null)).toThrow(/CHECK/i)
})
