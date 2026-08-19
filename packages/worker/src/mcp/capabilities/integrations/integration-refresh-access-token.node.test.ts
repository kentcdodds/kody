import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

vi.mock('#worker/integrations/package-subscriptions.ts', () => ({
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn<
		() => Promise<Array<unknown>>
	>(async () => []),
	dispatchIntegrationAuthSucceededSubscriptionEvents: vi.fn<
		() => Promise<Array<unknown>>
	>(async () => []),
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { PackageSecretAccessDeniedError } from '#mcp/secrets/package-access.ts'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { insertCommunityFork } from '#worker/community/repo.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	upsertIntegration,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import { createPlatformRawTokenRefusedMessage } from '#worker/integrations/token-refresh.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { integrationRefreshAccessTokenCapability } from './integration-refresh-access-token.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)
const storageContext = { sessionId: null, appId: null, packageId: null }

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { env }
}

async function seedUserLaneX(env: Env, userId: string) {
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
	await setSecretAllowedHosts({
		env,
		userId,
		name: 'x-kodykoalaRefreshToken',
		scope: 'user',
		allowedHosts: ['api.x.com'],
		storageContext,
	})
}

async function insertPackage(
	env: Env,
	userId: string,
	packageId: string,
	input: { name: string; kodyId: string } = {
		name: '@kentcdodds/x',
		kodyId: 'x',
	},
) {
	await insertSavedPackage(env.APP_DB, {
		id: packageId,
		user_id: userId,
		name: input.name,
		kody_id: input.kodyId,
		description: 'X helpers',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${packageId}`,
		has_app: 0,
	})
}

test('self-authored packages can materialize a refreshed access token without an allowed_packages write grant', async () => {
	const { env } = createHarness()
	const userId = 'user-x'
	const packageId = '0f5b1512-1e45-45f9-a08d-0c574055abda'
	await seedUserLaneX(env, userId)
	await insertPackage(env, userId, packageId)

	const fetchMock = vi.fn<typeof fetch>(
		async () =>
			new Response(
				JSON.stringify({
					access_token: 'fresh-x-access-token',
					refresh_token: 'rotated-x-refresh-token',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const result = await integrationRefreshAccessTokenCapability.handler(
			{ name: 'x-kodykoala' },
			{
				env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://kody.codes',
					user: {
						userId,
						email: 'me@kentcdodds.com',
						displayName: 'Kent',
					},
					storageContext: {
						sessionId: null,
						appId: null,
						packageId,
						storageId: null,
					},
				}),
			},
		)
		expect(result).toMatchObject({
			accessToken: 'fresh-x-access-token',
			refreshTokenRotated: true,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const forkPackageId = 'fork-pkg-1'
		await insertPackage(env, userId, forkPackageId, {
			name: '@someone/x',
			kodyId: 'x-fork',
		})
		await insertCommunityFork(env.APP_DB, {
			id: 'fork-1',
			listing_id: 'listing-1',
			forker_user_id: userId,
			origin_commit: 'abc123',
			forked_package_id: forkPackageId,
			forked_source_id: `source-${forkPackageId}`,
			target_kody_id: 'x',
			listing_name: '@someone/x',
			listing_kody_id: 'x',
		})
		fetchMock.mockClear()
		await expect(
			integrationRefreshAccessTokenCapability.handler(
				{ name: 'x-kodykoala' },
				{
					env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://kody.codes',
						user: {
							userId,
							email: 'me@kentcdodds.com',
							displayName: 'Kent',
						},
						storageContext: {
							sessionId: null,
							appId: null,
							packageId: forkPackageId,
							storageId: null,
						},
					}),
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
			expect(error).toBeInstanceOf(McpCallerError)
			expect((error as Error).message).toContain(
				'is not allowed for package "x-fork"',
			)
			return true
		})
		expect(fetchMock).not.toHaveBeenCalled()
	} finally {
		vi.unstubAllGlobals()
	}
})

test('platform integrations refuse raw-token materialize before contacting the provider', async () => {
	const { env } = createHarness()
	const userId = 'user-platform'
	const packageId = 'pkg-platform-1'
	await insertPackage(env, userId, packageId)
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

	const fetchMock = vi.fn<typeof fetch>(async () => {
		throw new Error('provider must not be contacted for platform raw tokens')
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(
			integrationRefreshAccessTokenCapability.handler(
				{ name: 'github' },
				{
					env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://kody.codes',
						user: {
							userId,
							email: 'me@kentcdodds.com',
							displayName: 'Kent',
						},
						storageContext: {
							sessionId: null,
							appId: null,
							packageId,
							storageId: null,
						},
					}),
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(McpCallerError)
			expect((error as Error).message).toBe(
				createPlatformRawTokenRefusedMessage('github'),
			)
			return true
		})
		expect(fetchMock).not.toHaveBeenCalled()
	} finally {
		vi.unstubAllGlobals()
	}
})
