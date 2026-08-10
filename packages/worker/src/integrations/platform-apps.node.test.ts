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

test('upsert lifecycle encrypts secrets, omits retain fields, null clears, and partial disable preserves data', async () => {
	const { sqlite, db, env } = createHarness()
	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			description: 'Send-only Gmail, no inbox.',
		},
	})

	const row = sqlite
		.prepare(
			'SELECT client_secret_encrypted FROM platform_oauth_apps WHERE slug = ?',
		)
		.get('github') as { client_secret_encrypted: string }
	expect(row.client_secret_encrypted).toBeTruthy()
	expect(row.client_secret_encrypted).not.toContain(
		'platform-github-client-secret-value',
	)
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	const app = await getPlatformOauthAppBySlug({ db, slug: 'github' })
	expect(app).toMatchObject({
		slug: 'github',
		provider: 'github',
		hasClientSecret: true,
		enabled: true,
		description: 'Send-only Gmail, no inbox.',
	})
	expect(JSON.stringify(app)).not.toContain(
		'platform-github-client-secret-value',
	)
	expect(Object.keys(app ?? {})).not.toContain('client_secret_encrypted')

	const retained = await upsertPlatformOauthApp({ db, env, app: baseGithubApp })
	expect(retained.description).toBe('Send-only Gmail, no inbox.')
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

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

	const clearedSecret = await upsertPlatformOauthApp({
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

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			clientSecret: 'platform-github-client-secret-value',
			description: 'Set again.',
		},
	})
	const clearedDescription = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: null },
	})
	expect(clearedDescription.description).toBeNull()

	const disabled = await upsertPlatformOauthApp({
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
	expect(disabled).toMatchObject({
		enabled: false,
		allowedScopes: ['gist', 'read:user', 'repo'],
		defaultScopes: ['read:user'],
		requiredHosts: ['api.github.com', 'github.com'],
		apiBaseUrl: 'https://api.github.com',
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	const clearedFields = await upsertPlatformOauthApp({
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
	expect(clearedFields.allowedScopes).toEqual([])
	expect(clearedFields.requiredHosts).toEqual([])
})

test('confidential flow requires a client secret only while enabled', async () => {
	const { db, env } = createHarness()
	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: { ...baseGithubApp, clientSecret: null },
		}),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)

	const staged = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, clientSecret: null, enabled: false },
	})
	expect(staged.enabled).toBe(false)
	expect(staged.hasClientSecret).toBe(false)

	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: {
				slug: baseGithubApp.slug,
				clientId: baseGithubApp.clientId,
				tokenUrl: baseGithubApp.tokenUrl,
				authorizeUrl: baseGithubApp.authorizeUrl,
				flow: 'confidential',
				enabled: true,
			},
		}),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)

	const live = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: baseGithubApp.slug,
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			clientSecret: 'late-pasted-secret',
			enabled: true,
		},
	})
	expect(live.enabled).toBe(true)
	expect(live.hasClientSecret).toBe(true)
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

test('listTopPlatformAppsByUse orders enabled apps by connection count and hides disabled', async () => {
	const { sqlite, db, env } = createHarness()
	for (const slug of ['github', 'google', 'notion', 'slack']) {
		await upsertPlatformOauthApp({
			db,
			env,
			app: {
				...baseGithubApp,
				slug,
				enabled: slug !== 'slack',
			},
		})
	}
	const insertConnection = sqlite.prepare(
		`INSERT INTO user_integrations (
			user_id, name, app_slug, platform_app_slug, access_token_secret_name
		) VALUES (?, ?, NULL, ?, ?)`,
	)
	insertConnection.run('user-1', 'google', 'google', 'googleAccessToken')
	insertConnection.run('user-2', 'google', 'google', 'googleAccessToken')
	insertConnection.run('user-1', 'notion', 'notion', 'notionAccessToken')
	insertConnection.run('user-1', 'slack', 'slack', 'slackAccessToken')
	insertConnection.run('user-2', 'slack', 'slack', 'slackAccessToken')
	insertConnection.run('user-3', 'slack', 'slack', 'slackAccessToken')

	const top = await listTopPlatformAppsByUse({ db, limit: 3 })
	expect(top.map((app) => app.slug)).toEqual(['google', 'notion', 'github'])

	const topTwo = await listTopPlatformAppsByUse({ db, limit: 2 })
	expect(topTwo.map((app) => app.slug)).toEqual(['google', 'notion'])
})

test('renamePlatformOauthApp carries the secret and moves connections atomically', async () => {
	const { sqlite, db, env } = createHarness()
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: 'Kody-hosted GitHub app.' },
	})
	sqlite
		.prepare(
			`UPDATE platform_oauth_apps SET logo_key = ?, logo_content_type = ?
			WHERE slug = ?`,
		)
		.run('platform-logos/github/abc123.png', 'image/png', 'github')
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, access_token_secret_name
			) VALUES (?, ?, NULL, ?, ?)`,
		)
		.run('user-1', 'github', 'github', 'githubAccessToken')

	const renamed = await renamePlatformOauthApp({
		db,
		slug: 'github',
		newSlug: 'github-platform',
	})
	expect(renamed).toMatchObject({
		slug: 'github-platform',
		provider: 'github',
		description: 'Kody-hosted GitHub app.',
		hasClientSecret: true,
		logoKey: 'platform-logos/github/abc123.png',
	})
	// The write-only encrypted secret decrypts under the new slug.
	expect(
		await getPlatformOauthAppClientSecret({
			db,
			env,
			slug: 'github-platform',
		}),
	).toBe('platform-github-client-secret-value')
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
	const movedConnection = sqlite
		.prepare(
			`SELECT name, platform_app_slug FROM user_integrations
			WHERE user_id = ?`,
		)
		.get('user-1') as { name: string; platform_app_slug: string }
	expect(movedConnection).toEqual({
		name: 'github',
		platform_app_slug: 'github-platform',
	})

	// Guards: missing source, same slug, and collisions all reject.
	await expect(
		renamePlatformOauthApp({ db, slug: 'missing', newSlug: 'other' }),
	).rejects.toThrow('was not found')
	await expect(
		renamePlatformOauthApp({
			db,
			slug: 'github-platform',
			newSlug: 'github-platform',
		}),
	).rejects.toThrow('matches the current slug')
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, slug: 'occupied' },
	})
	await expect(
		renamePlatformOauthApp({
			db,
			slug: 'github-platform',
			newSlug: 'occupied',
		}),
	).rejects.toThrow('already exists')
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
