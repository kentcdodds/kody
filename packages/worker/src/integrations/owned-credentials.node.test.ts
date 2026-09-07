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
	lockIntegrationToPackage,
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
	requiredHosts: ['www.googleapis.com', 'oauth2.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('integration-owned credentials persist as ciphertext, stay off secret lists, and survive sibling disconnect', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-owned-creds'
	seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })
	seedPackage(sqlite, { id: 'pkg-docs', userId, kodyId: 'docs' })

	await upsertIntegration({ env, userId, config: googleConfig })
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})
	await persistUserOauthAppClientSecret({
		env,
		userId,
		slug: 'google',
		value: 'client-secret-live',
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
		}),
	).toBe('access-live')
	expect(
		await resolveIntegrationRefreshToken({
			env,
			userId,
			name: 'google',
		}),
	).toBe('refresh-live')
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBe('client-secret-live')

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
		}),
	).toBeNull()

	expect(await listSecrets({ env, userId, scope: 'user' })).toEqual([])
	expect(await listUserSecretsForSearch({ env, userId })).toEqual([])
	expect(
		await resolveSecret({
			env,
			userId,
			name: 'googleAccessToken',
			scope: 'user',
			storageContext,
		}),
	).toMatchObject({ found: false })

	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})

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
		},
	})
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google-work',
		accessToken: 'work-access',
		refreshToken: 'work-refresh',
	})

	expect(await deleteIntegration({ env, userId, name: 'google-work' })).toBe(
		true,
	)
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBe('client-secret-live')

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
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBeNull()
})

test('disconnecting the last user-lane connection deletes the leftover client secret', async () => {
	const { env } = createHarness()
	const userId = 'user-last-disconnect'

	await upsertIntegration({ env, userId, config: googleConfig })
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})
	await persistUserOauthAppClientSecret({
		env,
		userId,
		slug: 'google',
		value: 'client-secret-live',
	})

	expect(await deleteIntegration({ env, userId, name: 'google' })).toBe(true)
	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
		}),
	).toBeNull()
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBeNull()
	expect(await listSecrets({ env, userId, scope: 'user' })).toEqual([])
})

test('lockIntegrationToPackage switches any-context usage to packages and rejects unknown packages', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-lock-usage'
	seedPackage(sqlite, { id: 'pkg-drafts', userId, kodyId: 'gmail-drafts' })
	await upsertIntegration({ env, userId, config: googleConfig })

	const grantedWhileAny = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-drafts',
	})
	expect(grantedWhileAny).toMatchObject({
		usageMode: 'any',
		allowedPackageIds: [],
	})

	const locked = await lockIntegrationToPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-drafts',
	})
	expect(locked).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-drafts'],
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
		packageId: 'pkg-drafts',
		packageKodyId: 'gmail-drafts',
	})

	await expect(
		lockIntegrationToPackage({
			env,
			userId,
			name: 'google',
			packageId: 'missing-package',
		}),
	).rejects.toThrow('Saved package not found for this user.')
})
