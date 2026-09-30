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
const baseUrl = 'https://kody.codes'

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

function createHarness(userId: string) {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	const seedPackage = (id: string, kodyId: string) =>
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id
				) VALUES (?, ?, ?, ?, '', ?)`,
			)
			.run(id, userId, kodyId, kodyId, `source-${id}`)
	const connect = async (
		name = 'google',
		tokens = { accessToken: 'access-live', refreshToken: 'refresh-live' },
	) => {
		await upsertIntegration({ env, userId, config: { ...googleConfig, name } })
		await persistIntegrationTokens({
			env,
			userId,
			name,
			refreshPolicy: 'required',
			...tokens,
		})
	}
	const persistClientSecret = () =>
		persistUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
			value: 'client-secret-live',
		})
	const clientSecret = () =>
		resolveUserOauthAppClientSecret({ env, userId, slug: 'google' })
	const accessToken = () =>
		resolveIntegrationAccessToken({ env, userId, name: 'google' })
	const canUse = (pkg?: { packageId: string; packageKodyId?: string }) =>
		assertCanUseIntegration({ env, baseUrl, userId, name: 'google', ...pkg })
	const grant = (packageId: string) =>
		grantIntegrationPackage({ env, userId, name: 'google', packageId })
	return {
		sqlite,
		env,
		seedPackage,
		connect,
		persistClientSecret,
		clientSecret,
		accessToken,
		canUse,
		grant,
	}
}

test('integration-owned credentials persist as ciphertext, stay off secret lists, and survive sibling disconnect', async () => {
	const userId = 'user-owned-creds'
	const harness = createHarness(userId)
	const { sqlite, env, canUse, grant, clientSecret, accessToken } = harness
	harness.seedPackage('pkg-mail', 'mail')
	harness.seedPackage('pkg-docs', 'docs')
	await harness.connect()
	await harness.persistClientSecret()

	const ciphertexts = [
		...Object.values(
			sqlite
				.prepare(
					`SELECT access_token_encrypted, refresh_token_encrypted
					FROM user_integrations WHERE user_id = ? AND name = ?`,
				)
				.get(userId, 'google') as Record<string, string>,
		),
		...Object.values(
			sqlite
				.prepare(
					`SELECT client_secret_encrypted FROM user_oauth_apps WHERE user_id = ? AND slug = ?`,
				)
				.get(userId, 'google') as Record<string, string>,
		),
	]
	expect(ciphertexts.map((value) => value.startsWith('v2.'))).toEqual([
		true,
		true,
		true,
	])
	expect(await accessToken()).toBe('access-live')
	expect(
		await resolveIntegrationRefreshToken({ env, userId, name: 'google' }),
	).toBe('refresh-live')
	expect(await clientSecret()).toBe('client-secret-live')

	sqlite
		.prepare(
			`UPDATE user_integrations
			SET access_token_encrypted = NULL, refresh_token_encrypted = NULL
			WHERE user_id = ? AND name = ?`,
		)
		.run(userId, 'google')
	expect(await accessToken()).toBeNull()
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

	await harness.connect()
	const mail = { packageId: 'pkg-mail', packageKodyId: 'mail' }
	await canUse()
	await canUse(mail)
	expect(await grant('pkg-mail')).toMatchObject({
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
	await expect(canUse()).rejects.toBeInstanceOf(
		IntegrationPackageAccessDeniedError,
	)
	await canUse(mail)
	await expect(
		canUse({ packageId: 'pkg-docs', packageKodyId: 'docs' }),
	).rejects.toThrow(
		buildIntegrationPackageApprovalUrl({
			baseUrl,
			name: 'google',
			packageId: 'pkg-docs',
			kodyId: 'docs',
		}),
	)
	expect(await grant('pkg-docs')).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-docs', 'pkg-mail'],
	})
	await canUse({ packageId: 'pkg-docs' })

	await harness.connect('google-work', {
		accessToken: 'work-access',
		refreshToken: 'work-refresh',
	})
	expect(await deleteIntegration({ env, userId, name: 'google-work' })).toBe(
		true,
	)
	expect(await clientSecret()).toBe('client-secret-live')
	expect(
		await deleteOauthAppWithConnections({ env, userId, slug: 'google' }),
	).toEqual({ deleted: true, connectionNames: ['google'] })
	expect(await clientSecret()).toBeNull()
})

test('disconnecting the last user-lane connection deletes the leftover client secret', async () => {
	const userId = 'user-last-disconnect'
	const { env, connect, persistClientSecret, clientSecret, accessToken } =
		createHarness(userId)
	await connect()
	await persistClientSecret()
	expect(await deleteIntegration({ env, userId, name: 'google' })).toBe(true)
	expect(await accessToken()).toBeNull()
	expect(await clientSecret()).toBeNull()
	expect(await listSecrets({ env, userId, scope: 'user' })).toEqual([])
})

test('lockIntegrationToPackage switches any-context usage to packages and rejects unknown packages', async () => {
	const userId = 'user-lock-usage'
	const { env, seedPackage, canUse, grant } = createHarness(userId)
	seedPackage('pkg-drafts', 'gmail-drafts')
	await upsertIntegration({ env, userId, config: googleConfig })
	expect(await grant('pkg-drafts')).toMatchObject({
		usageMode: 'any',
		allowedPackageIds: [],
	})
	const lock = (packageId: string) =>
		lockIntegrationToPackage({ env, userId, name: 'google', packageId })
	expect(await lock('pkg-drafts')).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-drafts'],
	})
	await expect(canUse()).rejects.toBeInstanceOf(
		IntegrationPackageAccessDeniedError,
	)
	await canUse({ packageId: 'pkg-drafts', packageKodyId: 'gmail-drafts' })
	await expect(lock('missing-package')).rejects.toThrow(
		'Saved package not found for this user.',
	)
})
