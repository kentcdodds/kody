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
	upsertPlatformOauthApp,
} from './platform-apps.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const env = {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Pick<Env, 'SECRET_STORE_KEY'>
	return { sqlite, db, env }
}

const baseGithubApp = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential' as const,
	allowedScopes: ['repo', 'read:user', 'gist'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com', 'github.com'],
}

test('upsertPlatformOauthApp stores the client secret encrypted, never in plaintext', async () => {
	const { sqlite, db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	const row = sqlite
		.prepare(
			'SELECT client_secret_encrypted FROM platform_oauth_apps WHERE slug = ?',
		)
		.get('github') as { client_secret_encrypted: string }
	expect(row.client_secret_encrypted).toBeTruthy()
	expect(row.client_secret_encrypted).not.toContain(
		'platform-github-client-secret-value',
	)

	const decrypted = await getPlatformOauthAppClientSecret({
		db,
		env,
		slug: 'github',
	})
	expect(decrypted).toBe('platform-github-client-secret-value')
})

test('platform app public shape exposes hasClientSecret but no ciphertext or value', async () => {
	const { db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	const app = await getPlatformOauthAppBySlug({ db, slug: 'github' })
	expect(app).toMatchObject({
		slug: 'github',
		provider: 'github',
		hasClientSecret: true,
		enabled: true,
	})
	expect(JSON.stringify(app)).not.toContain(
		'platform-github-client-secret-value',
	)
	expect(Object.keys(app ?? {})).not.toContain('client_secret_encrypted')
})

test('upsert keeps the stored secret when clientSecret is omitted and clears it on null', async () => {
	const { db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			clientSecret: undefined,
			label: 'GitHub (built-in)',
		},
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			flow: 'pkce',
			clientSecret: null,
		},
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBeNull()
})

test('partial saves retain omitted fields instead of clearing them', async () => {
	const { db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	const updated = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: 'github',
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			enabled: false,
		},
	})
	expect(updated).toMatchObject({
		enabled: false,
		allowedScopes: ['gist', 'read:user', 'repo'],
		defaultScopes: ['read:user'],
		requiredHosts: ['api.github.com', 'github.com'],
		apiBaseUrl: 'https://api.github.com',
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	// Explicit empty values still clear.
	const cleared = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: 'github',
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			allowedScopes: [],
			defaultScopes: [],
			requiredHosts: [],
		},
	})
	expect(cleared.allowedScopes).toEqual([])
	expect(cleared.requiredHosts).toEqual([])
})

test('confidential flow requires a client secret', async () => {
	const { db, env } = createHarness()
	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: { ...baseGithubApp, clientSecret: null },
		}),
	).rejects.toThrow('Confidential flow requires a client secret.')
})

test('allowedScopes always contains defaultScopes and disabled apps hide from the default list', async () => {
	const { db, env } = createHarness()
	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			allowedScopes: ['repo'],
			defaultScopes: ['read:user'],
			enabled: false,
		},
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
	const { sqlite, db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, access_token_secret_name
			) VALUES (?, ?, NULL, ?, ?)`,
		)
		.run('user-1', 'github', 'github', 'githubAccessToken')

	expect(await countConnectionsForPlatformApp({ db, slug: 'github' })).toBe(1)
	await expect(deletePlatformOauthApp({ db, slug: 'github' })).rejects.toThrow(
		'still has 1 user connection',
	)

	sqlite
		.prepare('DELETE FROM user_integrations WHERE user_id = ?')
		.run('user-1')
	expect(await deletePlatformOauthApp({ db, slug: 'github' })).toBe(true)
})

test('user_integrations enforces exactly one of app_slug / platform_app_slug', async () => {
	const { sqlite, db, env } = createHarness()
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO user_integrations (
					user_id, name, app_slug, platform_app_slug, access_token_secret_name
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run('user-1', 'github', 'github', 'github', 'githubAccessToken'),
	).toThrow(/CHECK/i)

	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO user_integrations (
					user_id, name, app_slug, platform_app_slug, access_token_secret_name
				) VALUES (?, ?, NULL, NULL, ?)`,
			)
			.run('user-1', 'github', 'githubAccessToken'),
	).toThrow(/CHECK/i)
})
