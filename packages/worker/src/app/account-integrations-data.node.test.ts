import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	upsertIntegration,
	upsertOauthAppWithoutConnection,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
	loadAccountOauthAppBySlug,
	loadExistingConnectionSummary,
} from './account-integrations-data.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	applyRepositoryMigrations(db, migrationsDirectory)
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite)
	return {
		env: { APP_DB: createD1FromSqlite(sqlite) } as Env,
	}
}

function fakeUser(userId: string) {
	return {
		email: 'user@example.com',
		username: 'user',
		mcpUser: { userId, email: 'user@example.com', username: 'user' },
	} as Parameters<typeof loadAccountIntegrationByName>[1]
}

const googleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'shared-google-client',
	accessTokenSecretName: 'googleAccessToken',
	refreshTokenSecretName: 'googleRefreshToken',
	requiredHosts: ['www.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('loadAccountIntegrationByName covers setup prefill, reconnect, and exact-slug apps', async () => {
	const { env } = createEnv()
	const userId = 'user-integrations-loader'

	expect(
		await loadAccountIntegrationByName(env, fakeUser(userId), 'linear'),
	).toBeNull()

	await upsertIntegration({
		env,
		userId,
		config: googleConfig,
	})

	const calendarSetup = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'google-calendar',
	)
	expect(calendarSetup).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		provider: 'google',
		clientId: 'shared-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		flow: 'pkce',
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: [],
		},
		accessTokenSecretName: 'google-calendarAccessToken',
		refreshTokenSecretName: 'google-calendarRefreshToken',
	})
	expect(calendarSetup?.clientSecretSecretName ?? null).toBeNull()
	expect(JSON.stringify(calendarSetup)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)

	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			name: 'google-calendar',
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
			authorization: {
				...googleConfig.authorization,
				scopes: ['calendar.readonly'],
			},
		},
	})

	const reconnect = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'google-calendar',
	)
	expect(reconnect).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		clientId: 'shared-google-client',
		accessTokenSecretName: 'googleCalendarAccessToken',
		refreshTokenSecretName: 'googleCalendarRefreshToken',
		authorization: {
			scopes: ['calendar.readonly'],
		},
	})

	await upsertOauthAppWithoutConnection({
		env,
		userId: 'user-abandoned',
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-from-setup',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	const connectionless = await loadAccountIntegrationByName(
		env,
		fakeUser('user-abandoned'),
		'notion',
	)
	expect(connectionless).toMatchObject({
		name: 'notion',
		appSlug: 'notion',
		clientId: 'notion-client-from-setup',
	})
})

test('connect lookup never prefills a built-in and converts platform reconnects to BYO', async () => {
	const { env } = createEnv()
	const userId = 'user-platform-priority'
	const platformEnv = {
		...env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: {
			slug: 'github',
			clientId: 'platform-github-client',
			clientSecret: 'platform-github-secret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			defaultScopes: ['read:user'],
		},
	})

	expect(
		await loadAccountIntegrationByName(env, fakeUser(userId), 'github'),
	).toBeNull()
	expect(
		await loadAccountIntegrationByName(env, fakeUser(userId), 'github-2', {
			appSlug: 'github',
		}),
	).toBeNull()

	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'github',
		name: 'github',
		scopes: ['read:user'],
		accessTokenSecretName: 'githubAccessToken',
	})
	const platformReconnect = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github',
	)
	expect(platformReconnect).toMatchObject({
		name: 'github',
		platform: false,
		clientId: '',
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['read:user'],
		},
	})
	expect(
		await loadExistingConnectionSummary(env, fakeUser(userId), 'github'),
	).toEqual({ lane: 'platform', appSlug: 'github' })

	const addAccountOnPlatform = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github-2',
		{ appSlug: 'github' },
	)
	expect(addAccountOnPlatform).toMatchObject({
		name: 'github-2',
		platform: false,
		clientId: '',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['read:user'],
		},
		accessTokenSecretName: 'github-2AccessToken',
		refreshTokenSecretName: 'github-2RefreshToken',
	})

	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientId: 'user-github-client',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: null,
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})
	const byoWins = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github',
	)
	expect(byoWins?.clientId).toBe('user-github-client')
	expect(byoWins?.platform ?? false).toBe(false)

	const familyPrefill = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github-2',
	)
	expect(familyPrefill).toMatchObject({
		name: 'github-2',
		appSlug: 'github',
		clientId: 'user-github-client',
	})
	expect(familyPrefill?.platform ?? false).toBe(false)

	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'linear',
			tokenUrl: 'https://api.linear.app/oauth/token',
			flow: 'confidential',
			clientId: 'user-linear-client',
			accessTokenSecretName: 'linearAccessToken',
			refreshTokenSecretName: null,
		},
	})
	const incomplete = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'linear',
	)
	expect(incomplete?.clientId).toBe('user-linear-client')
	expect(incomplete?.platform ?? false).toBe(false)

	const pinnedByo = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'work',
		{ appSlug: 'github' },
	)
	expect(pinnedByo).toMatchObject({
		name: 'work',
		appSlug: 'github',
		clientId: 'user-github-client',
	})
	expect(pinnedByo?.platform ?? false).toBe(false)

	const pinnedIncomplete = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github-platform',
		{ appSlug: 'linear' },
	)
	expect(pinnedIncomplete).toMatchObject({
		name: 'github-platform',
		appSlug: 'linear',
		clientId: 'user-linear-client',
	})
	expect(pinnedIncomplete?.platform ?? false).toBe(false)
})

test('loadAccountIntegrationsData includes OAuth apps with their connections', async () => {
	const { env } = createEnv()
	const userId = 'user-integrations-apps-loader'

	await upsertIntegration({
		env,
		userId,
		config: googleConfig,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			name: 'google-calendar',
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
			authorization: {
				...googleConfig.authorization,
				scopes: ['calendar.readonly'],
			},
		},
	})
	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-from-setup',
			clientSecretSecretName: 'notionClientSecret',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})

	const payload = await loadAccountIntegrationsData(env, fakeUser(userId))
	expect(payload.ok).toBe(true)
	expect(payload.integrations.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])
	expect(payload.apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug: 'google',
				provider: 'google',
				clientId: 'shared-google-client',
				clientSecretSecretName: null,
				connectionCount: 2,
				connections: expect.arrayContaining([
					expect.objectContaining({ name: 'google' }),
					expect.objectContaining({ name: 'google-calendar' }),
				]),
			}),
			expect.objectContaining({
				slug: 'notion',
				provider: 'notion',
				clientId: 'notion-client-from-setup',
				clientSecretSecretName: 'notionClientSecret',
				connectionCount: 0,
				connections: [],
			}),
		]),
	)
	expect(JSON.stringify(payload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)

	const googleApp = await loadAccountOauthAppBySlug(
		env,
		fakeUser(userId),
		'google',
	)
	expect(googleApp).toMatchObject({
		slug: 'google',
		clientId: 'shared-google-client',
		connectionCount: 2,
	})
	expect(
		await loadAccountOauthAppBySlug(env, fakeUser(userId), 'missing'),
	).toBeNull()
	expect(
		await loadAccountOauthAppBySlug(env, fakeUser('other-user'), 'google'),
	).toBeNull()
})

test('loadAccountIntegrationsData lists built-in apps next to user-registered apps', async () => {
	const { env } = createEnv()
	const userId = 'user-integrations-platform-list'
	const platformEnv = {
		...env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: {
			slug: 'google',
			label: 'Google',
			clientId: 'platform-google-client',
			clientSecret: 'platform-google-secret',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'confidential',
			defaultScopes: ['openid', 'email'],
		},
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'google',
		name: 'google',
		scopes: ['openid', 'email'],
		accessTokenSecretName: 'googleAccessToken',
		refreshTokenSecretName: 'googleRefreshToken',
		accountLabel: 'me@example.com',
	})
	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-from-setup',
			clientSecretSecretName: 'notionClientSecret',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})

	const payload = await loadAccountIntegrationsData(env, fakeUser(userId))
	expect(payload.apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug: 'google',
				platform: true,
				connectionCount: 1,
				connections: [
					expect.objectContaining({
						name: 'google',
						accountLabel: 'me@example.com',
					}),
				],
				clientSecretSecretName: null,
			}),
			expect.objectContaining({
				slug: 'notion',
				connectionCount: 0,
			}),
		]),
	)
	expect(payload.integrations).toEqual([
		expect.objectContaining({
			name: 'google',
			platform: true,
			accountLabel: 'me@example.com',
		}),
	])
})
