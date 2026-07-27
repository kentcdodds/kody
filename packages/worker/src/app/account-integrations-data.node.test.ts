import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	upsertIntegration,
	upsertOauthAppWithoutConnection,
} from '#worker/integrations/service.ts'
import {
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
	loadAccountOauthAppBySlug,
} from './account-integrations-data.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
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

	const githubBase = {
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential' as const,
		clientId: 'shared-github-client-id',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
		},
	}
	await upsertIntegration({
		env,
		userId,
		config: {
			...githubBase,
			name: 'github',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: null,
		},
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...githubBase,
			name: 'github-kent',
			clientSecretSecretName: 'github-kentClientSecret',
			accessTokenSecretName: 'githubKentAccessToken',
			refreshTokenSecretName: null,
		},
	})
	const githubWork = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github-work',
	)
	expect(githubWork).toMatchObject({
		name: 'github-work',
		clientId: 'shared-github-client-id',
		clientSecretSecretName: null,
		flow: 'confidential',
	})

	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientId: 'spotify-personal-client',
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'spotify-family',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientId: 'spotify-family-client',
			accessTokenSecretName: 'spotifyFamilyAccessToken',
			refreshTokenSecretName: 'spotifyFamilyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	const spotifyKids = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'spotify-kids',
	)
	expect(spotifyKids).toMatchObject({
		name: 'spotify-kids',
		clientId: '',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		flow: 'pkce',
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
