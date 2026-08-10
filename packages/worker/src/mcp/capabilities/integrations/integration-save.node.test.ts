import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationOauthAppListCapability } from './integration-oauth-app-list.ts'
import { integrationOauthAppRotateCredentialsCapability } from './integration-oauth-app-rotate-credentials.ts'
import { integrationSaveCapability } from './integration-save.ts'
import {
	integrationConfigSchema,
	mergeIntegrationConfig,
} from './integration-shared.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import { upsertPlatformIntegration } from '#worker/integrations/service.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	applyRepositoryMigrations(db, migrationsDirectory)
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite)
	return {
		sqlite,
		env: { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env,
	}
}

function caller(userId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId },
	})
}

const spotifyBase = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.com/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce' as const,
	clientId: 'spotify-client-id-value',
	clientSecretSecretName: null as string | null,
	accessTokenSecretName: 'spotifyAccessToken',
	refreshTokenSecretName: 'spotifyRefreshToken',
	requiredHosts: ['api.spotify.com'],
	authorization: {
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		scopes: ['user-read-email', 'playlist-read-private'],
		scopeSeparator: ' ',
		extraAuthorizeParams: { show_dialog: 'true' },
	},
}

const googleBase = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	// pkce apps do not persist a client secret (confidential-only at write time).
	clientSecretSecretName: null as string | null,
	accessTokenSecretName: 'googleAccessToken',
	refreshTokenSecretName: 'googleRefreshToken',
	requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null as string | null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('mergeIntegrationConfig and integration_save create a new app + connection with clientId shape', async () => {
	const current = integrationConfigSchema.parse({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientId: 'spotify-client-id-value',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	})

	expect(
		mergeIntegrationConfig(current, {
			name: 'spotify',
			apiBaseUrl: 'https://api.spotify.com/v2/',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
				scopes: ['user-read-email', 'playlist-read-private'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { prompt: 'consent' },
			},
			requiredHosts: ['https://api.spotify.com/v1', 'accounts.spotify.com'],
		}),
	).toEqual({
		...current,
		apiBaseUrl: 'https://api.spotify.com/v2/',
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
			extraAuthorizeParams: { prompt: 'consent' },
		},
		requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
	})

	const { env } = createEnv()
	const result = await integrationSaveCapability.handler(spotifyBase, {
		env,
		callerContext: caller('user-123'),
	})

	expect(result.integration).toEqual({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientId: 'spotify-client-id-value',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		requiredHosts: ['api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
			extraAuthorizeParams: { show_dialog: 'true' },
		},
	})
	expect(result.integration).not.toHaveProperty('clientIdValueName')
	expect(result.integration).not.toHaveProperty('usePkce')

	const listed = await integrationListCapability.handler(
		{},
		{ env, callerContext: caller('user-123') },
	)
	expect(listed.integrations).toHaveLength(1)
	expect(listed.integrations[0]).toEqual(result.integration)

	const got = await integrationGetCapability.handler(
		{ name: 'Spotify' },
		{ env, callerContext: caller('user-123') },
	)
	expect(got.integration).toEqual(result.integration)

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'spotify',
				flow: 'pkce',
				clientId: 'spotify-client-id-value',
			},
			{ env: createEnv().env, callerContext: caller('user-123') },
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			/missing or invalid required fields/i.test(error.message),
	)

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'slack',
				tokenUrl: 'https://slack.com/api/oauth.v2.access',
				flow: 'confidential',
				clientId: 'slack-client-id',
				// accessTokenSecretName omitted — create requires it
			},
			{ env: createEnv().env, callerContext: caller('user-123') },
		),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('integration_save reuses an existing app when credentials match and preserves unspecified fields on partial update', async () => {
	const { env } = createEnv()
	const userId = 'user-reuse'

	await integrationSaveCapability.handler(googleBase, {
		env,
		callerContext: caller(userId),
	})
	await integrationSaveCapability.handler(
		{
			...googleBase,
			name: 'google-calendar',
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
			authorization: {
				...googleBase.authorization,
				scopes: ['calendar.readonly'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
		{ env, callerContext: caller(userId) },
	)

	const apps = await integrationOauthAppListCapability.handler(
		{},
		{ env, callerContext: caller(userId) },
	)
	expect(apps.apps).toHaveLength(1)
	expect(apps.apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
		clientSecretSecretName: null,
	})
	expect(apps.apps[0]?.connections.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])

	const partial = await integrationSaveCapability.handler(
		{
			name: 'google',
			apiBaseUrl: 'https://www.googleapis.com/v2',
		},
		{ env, callerContext: caller(userId) },
	)
	expect(partial.integration).toMatchObject({
		name: 'google',
		apiBaseUrl: 'https://www.googleapis.com/v2',
		clientId: 'google-client-id-value',
		clientSecretSecretName: null,
		accessTokenSecretName: 'googleAccessToken',
		refreshTokenSecretName: 'googleRefreshToken',
		requiredHosts: ['accounts.google.com', 'www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid', 'email'],
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
		},
	})
	expect(partial.integration).not.toHaveProperty('tokenExchangeStyle')
})

test('integration_save persists usePkce only when it differs from the flow default', async () => {
	const { env: canvaEnv } = createEnv()
	const canvaResult = await integrationSaveCapability.handler(
		{
			name: 'canva',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com/rest/v1',
			flow: 'confidential',
			usePkce: true,
			clientId: 'canva-client-id-value',
			clientSecretSecretName: 'canvaClientSecret',
			accessTokenSecretName: 'canvaAccessToken',
			refreshTokenSecretName: 'canvaRefreshToken',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
		},
		{ env: canvaEnv, callerContext: caller('user-123') },
	)
	expect(canvaResult.integration).toMatchObject({
		name: 'canva',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
		clientId: 'canva-client-id-value',
	})

	const { env: defaultEnv } = createEnv()
	const defaultResult = await integrationSaveCapability.handler(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			usePkce: true,
			clientId: 'spotify-client-id-value',
			accessTokenSecretName: 'spotifyAccessToken',
			requiredHosts: ['api.spotify.com'],
		},
		{ env: defaultEnv, callerContext: caller('user-123') },
	)
	expect(defaultResult.integration).not.toHaveProperty('usePkce')
})

test('integration_delete removes a connection; credential rotation updates every sibling', async () => {
	const { env } = createEnv()
	const userId = 'user-rotate'

	await integrationSaveCapability.handler(googleBase, {
		env,
		callerContext: caller(userId),
	})
	await integrationSaveCapability.handler(
		{
			...googleBase,
			name: 'google-mail',
			accessTokenSecretName: 'googleMailAccessToken',
			refreshTokenSecretName: 'googleMailRefreshToken',
		},
		{ env, callerContext: caller(userId) },
	)

	const rotated = await integrationOauthAppRotateCredentialsCapability.handler(
		{
			slug: 'google',
			clientId: 'google-client-id-rotated',
			clientSecretSecretName: 'googleClientSecretRotated',
		},
		{ env, callerContext: caller(userId) },
	)
	expect(rotated.app).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		clientSecretSecretName: 'googleClientSecretRotated',
		connectionCount: 2,
	})
	expect(rotated.app).not.toHaveProperty('userId')
	expect(JSON.stringify(rotated.app)).not.toMatch(/Bearer |sk_|secret_value/i)

	const google = await integrationGetCapability.handler(
		{ name: 'google' },
		{ env, callerContext: caller(userId) },
	)
	const googleMail = await integrationGetCapability.handler(
		{ name: 'google-mail' },
		{ env, callerContext: caller(userId) },
	)
	expect(google.integration?.clientId).toBe('google-client-id-rotated')
	expect(google.integration?.clientSecretSecretName).toBe(
		'googleClientSecretRotated',
	)
	expect(googleMail.integration?.clientId).toBe('google-client-id-rotated')
	expect(googleMail.integration?.clientSecretSecretName).toBe(
		'googleClientSecretRotated',
	)

	const deletedMail = await integrationDeleteCapability.handler(
		{ name: 'google-mail' },
		{ env, callerContext: caller(userId) },
	)
	expect(deletedMail).toEqual({ deleted: true })

	const afterDelete = await integrationListCapability.handler(
		{},
		{ env, callerContext: caller(userId) },
	)
	expect(afterDelete.integrations.map((entry) => entry.name)).toEqual([
		'google',
	])

	const appsAfter = await integrationOauthAppListCapability.handler(
		{},
		{ env, callerContext: caller(userId) },
	)
	expect(appsAfter.apps).toHaveLength(1)
	expect(appsAfter.apps[0]?.connectionCount).toBe(1)

	const deletedGoogle = await integrationDeleteCapability.handler(
		{ name: 'google' },
		{ env, callerContext: caller(userId) },
	)
	expect(deletedGoogle).toEqual({ deleted: true })
	const emptyApps = await integrationOauthAppListCapability.handler(
		{},
		{ env, callerContext: caller(userId) },
	)
	expect(emptyApps.apps).toEqual([])
})

test('integration capabilities deny cross-user reads and require authentication', async () => {
	const { env } = createEnv()

	await integrationSaveCapability.handler(spotifyBase, {
		env,
		callerContext: caller('user-a'),
	})

	const otherUserList = await integrationListCapability.handler(
		{},
		{ env, callerContext: caller('user-b') },
	)
	expect(otherUserList.integrations).toEqual([])

	const otherUserGet = await integrationGetCapability.handler(
		{ name: 'spotify' },
		{ env, callerContext: caller('user-b') },
	)
	expect(otherUserGet.integration).toBeNull()

	const otherUserDelete = await integrationDeleteCapability.handler(
		{ name: 'spotify' },
		{ env, callerContext: caller('user-b') },
	)
	expect(otherUserDelete).toEqual({ deleted: false })

	const stillThere = await integrationGetCapability.handler(
		{ name: 'spotify' },
		{ env, callerContext: caller('user-a') },
	)
	expect(stillThere.integration?.name).toBe('spotify')

	await expect(
		integrationSaveCapability.handler(spotifyBase, {
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		}),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
})

test('integration identity is the canonical provider key across save and lookup', async () => {
	const { env } = createEnv()
	const saved = await integrationSaveCapability.handler(
		{
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientId: 'github-client-id-value',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			requiredHosts: ['api.github.com'],
		},
		{ env, callerContext: caller('user-123') },
	)
	expect(saved.integration.name).toBe('github')
	expect(saved.integration.clientId).toBe('github-client-id-value')

	const got = await integrationGetCapability.handler(
		{ name: 'GitHub' },
		{ env, callerContext: caller('user-123') },
	)
	expect(got.integration?.name).toBe('github')

	await expect(
		integrationSaveCapability.handler(
			{
				name: '._-',
				tokenUrl: 'https://example.com/token',
				flow: 'pkce',
				clientId: 'x-client-id',
				accessTokenSecretName: 'xAccessToken',
			},
			{ env: createEnv().env, callerContext: caller('user-123') },
		),
	).rejects.toThrow(/letters or numbers/i)
})

test('integration_save refuses platform (built-in) connections instead of converting them to the user lane', async () => {
	const { env } = createEnv()
	const platformEnv = {
		...env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	await upsertPlatformOauthApp({
		db: platformEnv.APP_DB,
		env: platformEnv,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			allowedScopes: ['read:user'],
		},
	})
	await upsertPlatformIntegration({
		env: platformEnv,
		userId: 'user-123',
		platformAppSlug: 'github',
		scopes: ['read:user'],
		accessTokenSecretName: 'githubAccessToken',
	})

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'github',
				requiredHosts: ['api.github.com'],
			},
			{ env: platformEnv, callerContext: caller('user-123') },
		),
	).rejects.toThrow(/platform \(built-in\) connection/)

	// The connection stays on the platform lane.
	const got = await integrationGetCapability.handler(
		{ name: 'github' },
		{ env: platformEnv, callerContext: caller('user-123') },
	)
	expect(got.integration?.platform).toBe(true)
})
