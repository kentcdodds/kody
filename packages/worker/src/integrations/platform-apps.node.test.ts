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

test('description saves, retains on omit, and clears on null', async () => {
	const { db, env } = createHarness()
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: 'Send-only Gmail, no inbox.' },
	})
	const retained = await upsertPlatformOauthApp({ db, env, app: baseGithubApp })
	expect(retained.description).toBe('Send-only Gmail, no inbox.')
	const cleared = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: null },
	})
	expect(cleared.description).toBeNull()
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

test('confidential flow requires a client secret only while enabled', async () => {
	const { db, env } = createHarness()
	// Enabled (default) without a secret is rejected as a validation error
	// (MCP re-wraps this as McpCallerError so it stays off Sentry).
	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: { ...baseGithubApp, clientSecret: null },
		}),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)

	// Staged provisioning: a disabled app saves without a secret so an
	// operator can paste credentials later.
	const staged = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, clientSecret: null, enabled: false },
	})
	expect(staged.enabled).toBe(false)
	expect(staged.hasClientSecret).toBe(false)

	// Enabling it while the secret is still missing is rejected, including
	// through a partial save that omits clientSecret (retain-on-omit keeps
	// the absent secret).
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

	// Once the secret lands, enabling works.
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
	// google: 2 connections, notion: 1, github: 0, slack (disabled): 3.
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
