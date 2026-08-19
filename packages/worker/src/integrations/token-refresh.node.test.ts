import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	saveSecret,
	resolveSecret,
	setSecretAllowedHosts,
} from '#mcp/secrets/service.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'
import {
	getJoinedIntegration,
	upsertIntegration,
	upsertPlatformIntegration,
} from './service.ts'

const mocks = vi.hoisted(() => ({
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn(async () => []),
	dispatchIntegrationAuthSucceededSubscriptionEvents: vi.fn(async () => []),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchIntegrationAuthFailedSubscriptionEvents:
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
	dispatchIntegrationAuthSucceededSubscriptionEvents:
		mocks.dispatchIntegrationAuthSucceededSubscriptionEvents,
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))

const {
	IntegrationRawTokenRefusedError,
	IntegrationTokenRefreshCallerError,
	integrationTokenRefreshCallerMarker,
	refreshAndMaterializeUserLaneAccessToken,
	refreshIntegrationTokens,
} = await import('./token-refresh.ts')

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env }
}

const storageContext = { sessionId: null, appId: null, packageId: null }

async function seedUserTokens(env: Env, userId: string, provider: string) {
	await saveSecret({
		env,
		userId,
		name: `${provider}AccessToken`,
		value: 'stale-access-token',
		scope: 'user',
		description: '',
		storageContext,
	})
	await saveSecret({
		env,
		userId,
		name: `${provider}RefreshToken`,
		value: 'current-refresh-token',
		scope: 'user',
		description: '',
		storageContext,
	})
}

function stubTokenEndpoint(payload: Record<string, unknown>) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

test('platform-lane refresh uses the decrypted shared client secret and persists tokens', async () => {
	const { env } = createHarness()
	const userId = 'user-platform-refresh'
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
		},
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
	})
	await seedUserTokens(env, userId, 'github')

	const fetchMock = stubTokenEndpoint({
		access_token: 'fresh-access-token',
		refresh_token: 'rotated-refresh-token',
	})
	try {
		const result = await refreshIntegrationTokens({
			env,
			userId,
			name: 'github',
		})
		expect(result.refreshTokenRotated).toBe(true)
		expect(JSON.stringify(result)).not.toContain('fresh-access-token')

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [tokenUrl, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(tokenUrl).toBe('https://github.com/login/oauth/access_token')
		const body = String(init.body)
		expect(body).toContain('grant_type=refresh_token')
		expect(body).toContain('refresh_token=current-refresh-token')
		expect(body).toContain('client_id=platform-github-client-id')
		expect(body).toContain('client_secret=platform-github-client-secret-value')

		const access = await resolveSecret({
			env,
			userId,
			name: 'githubAccessToken',
			scope: 'user',
			storageContext,
		})
		expect(access.found && access.value).toBe('fresh-access-token')
		const refresh = await resolveSecret({
			env,
			userId,
			name: 'githubRefreshToken',
			scope: 'user',
			storageContext,
		})
		expect(refresh.found && refresh.value).toBe('rotated-refresh-token')
		expect(
			mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
		).not.toHaveBeenCalled()
		expect(
			mocks.dispatchIntegrationAuthSucceededSubscriptionEvents,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				source: 'refresh',
				integration: expect.objectContaining({
					name: 'github',
					lane: 'platform',
				}),
			}),
		)
	} finally {
		vi.unstubAllGlobals()
	}

	mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
	mocks.dispatchIntegrationAuthSucceededSubscriptionEvents.mockClear()
	await expect(
		refreshIntegrationTokens({
			env,
			userId,
			name: 'missing-connection',
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof IntegrationTokenRefreshCallerError &&
			error.reason === 'not_found',
	)
	expect(
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
	).not.toHaveBeenCalled()
	expect(
		mocks.dispatchIntegrationAuthSucceededSubscriptionEvents,
	).not.toHaveBeenCalled()

	await upsertPlatformIntegration({
		env,
		userId: 'user-no-refresh',
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
	await expect(
		refreshIntegrationTokens({
			env,
			userId: 'user-no-refresh',
			name: 'github',
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof IntegrationTokenRefreshCallerError &&
			error.reason === 'missing_refresh_token' &&
			error.message.includes('does not define a refresh token secret name') &&
			error.message.includes('/connect/oauth?provider=github') &&
			error.message.includes(integrationTokenRefreshCallerMarker),
	)
	expect(
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-no-refresh',
			reason: 'missing_refresh_token',
			integration: expect.objectContaining({
				name: 'github',
				lane: 'platform',
			}),
		}),
	)
})

test('provider HTTP status classifies refresh failures as caller errors or Sentry-visible Errors', async () => {
	const { env } = createHarness()
	const userId = 'user-google-provider-status'
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'google',
			clientId: 'platform-google-client-id',
			clientSecret: 'platform-google-client-secret-value',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'confidential',
		},
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'google',
		scopes: [],
		accessTokenSecretName: 'googleAccessToken',
		refreshTokenSecretName: 'googleRefreshToken',
	})
	await seedUserTokens(env, userId, 'google')

	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: 'invalid_grant',
					error_description: 'Token has been expired or revoked.',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'server_error' }), {
				status: 503,
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: '' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
		const waitUntil = vi.fn()
		await expect(
			refreshIntegrationTokens({
				env,
				userId,
				name: 'google',
				waitUntil,
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof IntegrationTokenRefreshCallerError &&
				error.reason === 'provider_rejected' &&
				error.providerError === 'invalid_grant' &&
				error.httpStatus === 400 &&
				error.message.includes('HTTP 400') &&
				error.message.includes('invalid_grant') &&
				error.message.includes('/connect/oauth?provider=google') &&
				error.message.includes(integrationTokenRefreshCallerMarker),
		)
		expect(waitUntil).toHaveBeenCalledTimes(1)
		await waitUntil.mock.calls[0]?.[0]
		expect(
			mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				reason: 'provider_rejected',
				provider: {
					error: 'invalid_grant',
					error_description: 'Token has been expired or revoked.',
					http_status: 400,
				},
			}),
		)

		mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
		await expect(
			refreshIntegrationTokens({
				env,
				userId,
				name: 'google',
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				!(error instanceof IntegrationTokenRefreshCallerError) &&
				error.message.includes('HTTP 503'),
		)
		expect(
			mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
		).not.toHaveBeenCalled()

		mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
		await expect(
			refreshIntegrationTokens({
				env,
				userId,
				name: 'google',
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof IntegrationTokenRefreshCallerError &&
				error.reason === 'provider_rejected' &&
				error.message.includes('did not return an access_token'),
		)
		expect(
			mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'provider_rejected',
			}),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

async function approveSecretHosts(
	env: Env,
	userId: string,
	name: string,
	allowedHosts: Array<string>,
) {
	await setSecretAllowedHosts({
		env,
		userId,
		name,
		scope: 'user',
		allowedHosts,
		storageContext,
	})
}

test('user-lane refresh resolves the client secret from the user secret store', async () => {
	const { env } = createHarness()
	const userId = 'user-lane-refresh'
	await saveSecret({
		env,
		userId,
		name: 'googleClientSecret',
		value: 'user-google-client-secret',
		scope: 'user',
		description: '',
		storageContext,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			flow: 'confidential',
			clientId: 'user-google-client-id',
			clientSecretSecretName: 'googleClientSecret',
			accessTokenSecretName: 'googleAccessToken',
			refreshTokenSecretName: 'googleRefreshToken',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['openid'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})
	await seedUserTokens(env, userId, 'google')

	const fetchMock = stubTokenEndpoint({ access_token: 'fresh-google-token' })
	try {
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents.mockClear()
		await expect(
			refreshIntegrationTokens({ env, userId, name: 'google' }),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof IntegrationTokenRefreshCallerError &&
				error.reason === 'host_not_approved' &&
				error.message.includes(
					'Secret "googleRefreshToken" is not approved for host "oauth2.googleapis.com"',
				) &&
				error.message.includes(integrationTokenRefreshCallerMarker),
		)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(
			mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'host_not_approved',
				integration: expect.objectContaining({
					name: 'google',
					lane: 'user',
				}),
			}),
		)

		await approveSecretHosts(env, userId, 'googleRefreshToken', [
			'oauth2.googleapis.com',
		])
		await approveSecretHosts(env, userId, 'googleClientSecret', [
			'oauth2.googleapis.com',
		])
		const result = await refreshIntegrationTokens({
			env,
			userId,
			name: 'google',
		})
		expect(result.refreshTokenRotated).toBe(false)

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(String(init.body)).toContain(
			'client_secret=user-google-client-secret',
		)

		const access = await resolveSecret({
			env,
			userId,
			name: 'googleAccessToken',
			scope: 'user',
			storageContext,
		})
		expect(access.found && access.value).toBe('fresh-google-token')
		expect(
			mocks.dispatchIntegrationAuthSucceededSubscriptionEvents,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				source: 'refresh',
				integration: expect.objectContaining({
					name: 'google',
					lane: 'user',
				}),
			}),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('successful Google refresh persists userinfo email as account_label when missing', async () => {
	const { env } = createHarness()
	const userId = 'user-google-label'
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'google',
			clientId: 'platform-google-client-id',
			clientSecret: 'platform-google-client-secret-value',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'confidential',
			requiredHosts: ['oauth2.googleapis.com', 'openidconnect.googleapis.com'],
			allowedScopes: ['openid', 'email'],
			defaultScopes: ['openid', 'email'],
		},
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'google',
		scopes: ['openid', 'email'],
		accessTokenSecretName: 'googleAccessToken',
		refreshTokenSecretName: 'googleRefreshToken',
	})
	await seedUserTokens(env, userId, 'google')

	const fetchMock = vi.fn(async (url: string | URL | Request) => {
		const href = String(url)
		if (href.includes('openidconnect.googleapis.com')) {
			return new Response(JSON.stringify({ email: 'kent.c.dodds@gmail.com' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response(
			JSON.stringify({ access_token: 'fresh-google-token' }),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			},
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		await refreshIntegrationTokens({
			env,
			userId,
			name: 'google',
		})
		const joined = await getJoinedIntegration({
			env,
			userId,
			name: 'google',
		})
		expect(joined?.connection.accountLabel).toBe('kent.c.dodds@gmail.com')
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await upsertPlatformIntegration({
			env,
			userId,
			platformAppSlug: 'google',
			scopes: ['openid', 'email'],
			accessTokenSecretName: 'googleAccessToken',
			refreshTokenSecretName: 'googleRefreshToken',
			accountLabel: 'Work',
		})
		await refreshIntegrationTokens({
			env,
			userId,
			name: 'google',
		})
		const labeled = await getJoinedIntegration({
			env,
			userId,
			name: 'google',
		})
		expect(labeled?.connection.accountLabel).toBe('Work')
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(
			fetchMock.mock.calls.filter(([url]) =>
				String(url).includes('openidconnect.googleapis.com'),
			),
		).toHaveLength(1)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('user-lane refreshAccessToken host path persists without a package write grant and returns the access token', async () => {
	const { env } = createHarness()
	const userId = 'user-lane-materialize'
	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'x-kodykoala',
			tokenUrl: 'https://api.x.com/2/oauth2/token',
			flow: 'pkce',
			clientId: 'x-client-id',
			accessTokenSecretName: 'x-kodykoalaAccessToken',
			refreshTokenSecretName: 'x-kodykoalaRefreshToken',
			requiredHosts: ['api.x.com'],
			authorization: {
				authorizeUrl: 'https://x.com/i/oauth2/authorize',
				scopes: ['tweet.read'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	await saveSecret({
		env,
		userId,
		name: 'x-kodykoalaAccessToken',
		value: 'stale-access-token',
		scope: 'user',
		description: '',
		storageContext,
	})
	await saveSecret({
		env,
		userId,
		name: 'x-kodykoalaRefreshToken',
		value: 'current-refresh-token',
		scope: 'user',
		description: '',
		storageContext,
	})
	await approveSecretHosts(env, userId, 'x-kodykoalaRefreshToken', [
		'api.x.com',
	])

	const fetchMock = stubTokenEndpoint({
		access_token: 'fresh-x-access-token',
		refresh_token: 'rotated-x-refresh-token',
	})
	try {
		const result = await refreshAndMaterializeUserLaneAccessToken({
			env,
			userId,
			name: 'x-kodykoala',
		})
		expect(result.accessToken).toBe('fresh-x-access-token')
		expect(result.refreshTokenRotated).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const persistedAccess = await resolveSecret({
			env,
			userId,
			name: 'x-kodykoalaAccessToken',
			scope: 'user',
			storageContext,
		})
		expect(persistedAccess.found && persistedAccess.value).toBe(
			'fresh-x-access-token',
		)
		expect(persistedAccess.found && persistedAccess.allowedPackages).toEqual([])
	} finally {
		vi.unstubAllGlobals()
	}

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
		},
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
	})
	await seedUserTokens(env, userId, 'github')
	await expect(
		refreshAndMaterializeUserLaneAccessToken({
			env,
			userId,
			name: 'github',
		}),
	).rejects.toBeInstanceOf(IntegrationRawTokenRefusedError)
})
