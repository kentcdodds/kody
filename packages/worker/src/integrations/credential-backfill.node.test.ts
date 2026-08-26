import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { backfillIntegrationCredentials } from './credential-backfill.ts'
import {
	persistIntegrationTokens,
	resolveIntegrationAccessToken,
	resolveIntegrationRefreshToken,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import { upsertIntegration } from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const storageContext = { sessionId: null, appId: null, packageId: null }

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

const leftoverConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'confidential' as const,
	clientId: 'google-client-id',
	clientSecretSecretName: 'googleClientSecret',
	accessTokenSecretName: 'googleAccessToken',
	refreshTokenSecretName: 'googleRefreshToken',
	requiredHosts: ['www.googleapis.com', 'oauth2.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

async function seedLeftoverConnection(input: {
	env: Env
	userId: string
	userEmail: string
	accessToken?: string
	refreshToken?: string
	clientSecret?: string
}) {
	await upsertIntegration({
		env: input.env,
		userId: input.userId,
		config: leftoverConfig,
	})
	if (input.accessToken) {
		await saveSecret({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			name: leftoverConfig.accessTokenSecretName,
			value: input.accessToken,
			scope: 'user',
			description: 'leftover access',
			storageContext,
		})
	}
	if (input.refreshToken) {
		await saveSecret({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			name: leftoverConfig.refreshTokenSecretName,
			value: input.refreshToken,
			scope: 'user',
			description: 'leftover refresh',
			storageContext,
		})
	}
	if (input.clientSecret) {
		await saveSecret({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			name: leftoverConfig.clientSecretSecretName,
			value: input.clientSecret,
			scope: 'user',
			description: 'leftover client secret',
			storageContext,
		})
	}
}

function readCiphertexts(sqlite: DatabaseSync, userId: string) {
	return sqlite
		.prepare(
			`SELECT access_token_encrypted, refresh_token_encrypted
			FROM user_integrations
			WHERE user_id = ? AND name = ?`,
		)
		.get(userId, leftoverConfig.name) as {
		access_token_encrypted: string | null
		refresh_token_encrypted: string | null
	}
}

test('dry-run counts leftover named secrets and does not write ciphertext', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-leftover-dry'
	await seedLeftoverConnection({
		env,
		userId,
		userEmail: 'leftover@example.com',
		accessToken: 'access-leftover',
		refreshToken: 'refresh-leftover',
		clientSecret: 'client-leftover',
	})

	const result = await backfillIntegrationCredentials({
		env,
		dryRun: true,
	})

	expect(result).toEqual({
		dryRun: true,
		userIntegrations: {
			access: {
				leftover: 1,
				scanned: 1,
				copied: 1,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 1,
			},
			refresh: {
				leftover: 1,
				scanned: 1,
				copied: 1,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 1,
			},
		},
		userOauthApps: {
			clientSecret: {
				leftover: 1,
				scanned: 1,
				copied: 1,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 1,
			},
		},
		missingSecrets: [],
	})
	expect(JSON.stringify(result)).not.toMatch(
		/access-leftover|refresh-leftover|client-leftover/,
	)
	const ciphertexts = readCiphertexts(sqlite, userId)
	expect(ciphertexts.access_token_encrypted).toBeNull()
	expect(ciphertexts.refresh_token_encrypted).toBeNull()
	expect(
		(
			sqlite
				.prepare(
					`SELECT client_secret_encrypted
					FROM user_oauth_apps
					WHERE user_id = ? AND slug = ?`,
				)
				.get(userId, leftoverConfig.name) as {
				client_secret_encrypted: string | null
			}
		).client_secret_encrypted,
	).toBeNull()
})

test('write copies leftover secret-store values onto ciphertext and leaves existing columns alone', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-leftover-write'
	const userEmail = 'write@example.com'
	await seedLeftoverConnection({
		env,
		userId,
		userEmail,
		accessToken: 'access-from-store',
		refreshToken: 'refresh-from-store',
		clientSecret: 'client-from-store',
	})
	await persistIntegrationTokens({
		env,
		userId,
		userEmail,
		name: leftoverConfig.name,
		accessToken: 'access-already-on-connection',
		refreshToken: null,
		accessTokenSecretName: leftoverConfig.accessTokenSecretName,
		refreshTokenSecretName: leftoverConfig.refreshTokenSecretName,
		descriptionPrefix: 'google',
	})
	sqlite
		.prepare(
			`UPDATE user_integrations
			SET refresh_token_encrypted = NULL
			WHERE user_id = ? AND name = ?`,
		)
		.run(userId, leftoverConfig.name)

	const result = await backfillIntegrationCredentials({ env })
	expect(result.dryRun).toBe(false)
	expect(result.userIntegrations.access).toMatchObject({
		leftover: 0,
		scanned: 0,
		copied: 0,
		remaining: 0,
	})
	expect(result.userIntegrations.refresh).toMatchObject({
		leftover: 1,
		scanned: 1,
		copied: 1,
		remaining: 0,
	})
	expect(result.userOauthApps.clientSecret).toMatchObject({
		leftover: 1,
		scanned: 1,
		copied: 1,
		remaining: 0,
	})
	expect(result.missingSecrets).toEqual([])
	expect(JSON.stringify(result)).not.toMatch(
		/access-from-store|refresh-from-store|client-from-store|access-already-on-connection/,
	)

	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: leftoverConfig.name,
			secretName: leftoverConfig.accessTokenSecretName,
		}),
	).toBe('access-already-on-connection')
	expect(
		await resolveIntegrationRefreshToken({
			env,
			userId,
			name: leftoverConfig.name,
			secretName: leftoverConfig.refreshTokenSecretName,
		}),
	).toMatchObject({ value: 'refresh-from-store', source: 'integration' })
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: leftoverConfig.name,
			secretName: leftoverConfig.clientSecretSecretName,
		}),
	).toMatchObject({ value: 'client-from-store', source: 'integration' })
})

test('missing leftover secrets are counted and left null', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-leftover-missing'
	await seedLeftoverConnection({
		env,
		userId,
		userEmail: 'missing@example.com',
	})

	const result = await backfillIntegrationCredentials({
		env,
		dryRun: true,
	})
	expect(result.userIntegrations.access).toMatchObject({
		leftover: 1,
		scanned: 1,
		copied: 0,
		missingSecret: 1,
		remaining: 1,
	})
	expect(result.userIntegrations.refresh).toMatchObject({
		leftover: 1,
		scanned: 1,
		copied: 0,
		missingSecret: 1,
		remaining: 1,
	})
	expect(result.userOauthApps.clientSecret).toMatchObject({
		leftover: 1,
		scanned: 1,
		copied: 0,
		missingSecret: 1,
		remaining: 1,
	})
	expect(result.missingSecrets).toEqual([
		{
			table: 'user_integrations',
			key: `${userId}:${leftoverConfig.name}:access`,
			reason: 'not_found',
		},
		{
			table: 'user_integrations',
			key: `${userId}:${leftoverConfig.name}:refresh`,
			reason: 'not_found',
		},
		{
			table: 'user_oauth_apps',
			key: `${userId}:${leftoverConfig.name}:clientSecret`,
			reason: 'not_found',
		},
	])
	expect(readCiphertexts(sqlite, userId).access_token_encrypted).toBeNull()
})

test('write does not overwrite ciphertext when a persist lands first', async () => {
	const { env } = createHarness()
	const userId = 'user-leftover-race'
	const userEmail = 'race@example.com'
	await seedLeftoverConnection({
		env,
		userId,
		userEmail,
		accessToken: 'access-from-store',
	})
	await persistIntegrationTokens({
		env,
		userId,
		userEmail,
		name: leftoverConfig.name,
		accessToken: 'access-won-the-race',
		refreshToken: null,
		accessTokenSecretName: leftoverConfig.accessTokenSecretName,
		descriptionPrefix: 'google',
	})

	const result = await backfillIntegrationCredentials({ env })
	expect(result.userIntegrations.access).toMatchObject({
		leftover: 0,
		scanned: 0,
		copied: 0,
		remaining: 0,
	})
	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: leftoverConfig.name,
			secretName: leftoverConfig.accessTokenSecretName,
		}),
	).toBe('access-won-the-race')
})
