import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	listSecrets,
	listUserSecretsForSearch,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	deleteIntegrationOwnedSecrets,
	persistIntegrationTokens,
	persistUserOauthAppClientSecret,
	resolveIntegrationAccessToken,
	resolveIntegrationRefreshToken,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import {
	assertCanUseIntegration,
	buildIntegrationPackageApprovalUrl,
	IntegrationPackageAccessDeniedError,
} from './package-access.ts'
import {
	deleteIntegration,
	deleteOauthAppWithConnections,
	grantIntegrationPackage,
	setIntegrationUsage,
	upsertIntegration,
} from './service.ts'

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

function seedPackage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.kodyId,
			input.kodyId,
			'',
			`source-${input.id}`,
		)
}

const googleConfig = {
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

test('integration-owned credentials persist, hide, grant, approve, and disconnect without dropping the shared client secret', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-owned-creds'
	const userEmail = 'user@example.com'
	seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })
	seedPackage(sqlite, { id: 'pkg-docs', userId, kodyId: 'docs' })

	await upsertIntegration({ env, userId, config: googleConfig })
	await persistIntegrationTokens({
		env,
		userId,
		userEmail,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
		accessTokenSecretName: 'googleAccessToken',
		refreshTokenSecretName: 'googleRefreshToken',
		descriptionPrefix: 'google',
	})
	await persistUserOauthAppClientSecret({
		env,
		userId,
		userEmail,
		slug: 'google',
		value: 'client-secret-live',
		secretName: 'googleClientSecret',
		description: 'google OAuth client secret',
	})

	const ciphertexts = sqlite
		.prepare(
			`SELECT access_token_encrypted, refresh_token_encrypted
			FROM user_integrations
			WHERE user_id = ? AND name = ?`,
		)
		.get(userId, 'google') as {
		access_token_encrypted: string
		refresh_token_encrypted: string
	}
	expect(ciphertexts.access_token_encrypted.startsWith('v2.')).toBe(true)
	expect(ciphertexts.refresh_token_encrypted.startsWith('v2.')).toBe(true)
	expect(
		(
			sqlite
				.prepare(
					`SELECT client_secret_encrypted
					FROM user_oauth_apps
					WHERE user_id = ? AND slug = ?`,
				)
				.get(userId, 'google') as { client_secret_encrypted: string }
		).client_secret_encrypted.startsWith('v2.'),
	).toBe(true)

	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
			secretName: 'googleAccessToken',
		}),
	).toBe('access-live')
	expect(
		await resolveIntegrationRefreshToken({
			env,
			userId,
			name: 'google',
			secretName: 'googleRefreshToken',
		}),
	).toMatchObject({ value: 'refresh-live', source: 'integration' })
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
			secretName: 'googleClientSecret',
		}),
	).toMatchObject({ value: 'client-secret-live', source: 'integration' })

	sqlite
		.prepare(
			`UPDATE user_integrations
			SET access_token_encrypted = NULL, refresh_token_encrypted = NULL
			WHERE user_id = ? AND name = ?`,
		)
		.run(userId, 'google')
	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
			secretName: 'googleAccessToken',
		}),
	).toBe('access-live')

	const listed = await listSecrets({ env, userId, scope: 'user' })
	expect(listed.map((secret) => secret.name)).toEqual([])
	const listedOwned = await listSecrets({
		env,
		userId,
		scope: 'user',
		includeIntegrationOwned: true,
	})
	expect(listedOwned.map((secret) => secret.name).sort()).toEqual([
		'googleAccessToken',
		'googleClientSecret',
		'googleRefreshToken',
	])
	expect(await listUserSecretsForSearch({ env, userId })).toEqual([])

	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
	})
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-mail',
		packageKodyId: 'mail',
	})

	const grantedAny = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-mail',
	})
	expect(grantedAny).toMatchObject({
		usageMode: 'any',
		allowedPackageIds: [],
	})

	await setIntegrationUsage({
		env,
		userId,
		name: 'google',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})
	await expect(
		assertCanUseIntegration({
			env,
			baseUrl: 'https://kody.codes',
			userId,
			name: 'google',
		}),
	).rejects.toBeInstanceOf(IntegrationPackageAccessDeniedError)
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-mail',
		packageKodyId: 'mail',
	})
	await expect(
		assertCanUseIntegration({
			env,
			baseUrl: 'https://kody.codes',
			userId,
			name: 'google',
			packageId: 'pkg-docs',
			packageKodyId: 'docs',
		}),
	).rejects.toThrow(
		buildIntegrationPackageApprovalUrl({
			baseUrl: 'https://kody.codes',
			name: 'google',
			packageId: 'pkg-docs',
			kodyId: 'docs',
		}),
	)

	const grantedDocs = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-docs',
	})
	expect(grantedDocs).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-docs', 'pkg-mail'],
	})
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-docs',
	})

	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			name: 'google-work',
			accessTokenSecretName: 'googleWorkAccessToken',
			refreshTokenSecretName: 'googleWorkRefreshToken',
		},
	})
	await persistIntegrationTokens({
		env,
		userId,
		userEmail,
		name: 'google-work',
		accessToken: 'work-access',
		refreshToken: 'work-refresh',
		accessTokenSecretName: 'googleWorkAccessToken',
		refreshTokenSecretName: 'googleWorkRefreshToken',
		descriptionPrefix: 'google-work',
	})

	expect(await deleteIntegration({ env, userId, name: 'google-work' })).toBe(
		true,
	)
	expect(
		await resolveSecret({
			env,
			userId,
			name: 'googleWorkAccessToken',
			scope: 'user',
			storageContext,
		}),
	).toMatchObject({ found: false })
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
			secretName: 'googleClientSecret',
		}),
	).toMatchObject({ value: 'client-secret-live', source: 'integration' })

	await deleteIntegrationOwnedSecrets({
		env,
		userId,
		secretNames: ['googleAccessToken', 'googleRefreshToken'],
	})
	const deletedApp = await deleteOauthAppWithConnections({
		env,
		userId,
		slug: 'google',
	})
	expect(deletedApp).toEqual({
		deleted: true,
		connectionNames: ['google'],
	})
	expect(
		await resolveSecret({
			env,
			userId,
			name: 'googleClientSecret',
			scope: 'user',
			storageContext,
		}),
	).toMatchObject({ found: false })
})
