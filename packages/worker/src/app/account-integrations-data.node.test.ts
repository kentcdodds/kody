import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	upsertIntegration,
	upsertOauthAppWithoutConnection,
} from '#worker/integrations/service.ts'
import { loadAccountIntegrationByName } from './account-integrations-data.ts'

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

test('loadAccountIntegrationByName prefills shared google client id for google-calendar setup', async () => {
	const { env } = createEnv()
	const userId = 'user-calendar-setup'

	await upsertIntegration({
		env,
		userId,
		config: googleConfig,
	})

	const record = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'google-calendar',
	)
	expect(record).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		provider: 'google',
		clientId: 'shared-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce',
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: [],
		},
		accessTokenSecretName: 'google-calendarAccessToken',
		refreshTokenSecretName: 'google-calendarRefreshToken',
	})
	// Prefill exposes secret *names* and client id, never token values.
	expect(record?.clientSecretSecretName ?? null).toBeNull()
	expect(JSON.stringify(record)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)
})

test('loadAccountIntegrationByName returns null for a brand-new provider', async () => {
	const { env } = createEnv()
	const record = await loadAccountIntegrationByName(
		env,
		fakeUser('user-new'),
		'linear',
	)
	expect(record).toBeNull()
})

test('loadAccountIntegrationByName reconnects through the connection, not family fallback', async () => {
	const { env } = createEnv()
	const userId = 'user-reconnect'

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

	const record = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'google-calendar',
	)
	expect(record).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		clientId: 'shared-google-client',
		accessTokenSecretName: 'googleCalendarAccessToken',
		refreshTokenSecretName: 'googleCalendarRefreshToken',
		authorization: {
			scopes: ['calendar.readonly'],
		},
	})
})

test('loadAccountIntegrationByName omits client id when family apps disagree on it', async () => {
	const { env } = createEnv()
	const userId = 'user-spotify-split'

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

	const record = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'spotify-kids',
	)
	expect(record).toMatchObject({
		name: 'spotify-kids',
		clientId: '',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		flow: 'pkce',
	})
})

test('loadAccountIntegrationByName prefills shared github client id but not disagreed secret names', async () => {
	const { env } = createEnv()
	const userId = 'user-github-split'

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

	const record = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'github-work',
	)
	expect(record).toMatchObject({
		name: 'github-work',
		clientId: 'shared-github-client-id',
		clientSecretSecretName: null,
		tokenUrl: 'https://github.com/login/oauth/access_token',
		flow: 'confidential',
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
		},
	})
	expect(record?.clientSecretSecretName).toBeNull()
	expect(JSON.stringify(record)).not.toMatch(
		/githubClientSecret|github-kentClientSecret/,
	)
})

test('loadAccountIntegrationByName surfaces a connectionless exact-slug setup app', async () => {
	const { env } = createEnv()
	const userId = 'user-abandoned'

	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			clientId: 'spotify-client-from-setup',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
			},
		},
	})

	const record = await loadAccountIntegrationByName(
		env,
		fakeUser(userId),
		'spotify',
	)
	expect(record).toMatchObject({
		name: 'spotify',
		appSlug: 'spotify',
		clientId: 'spotify-client-from-setup',
		tokenUrl: 'https://accounts.spotify.com/api/token',
	})
})
