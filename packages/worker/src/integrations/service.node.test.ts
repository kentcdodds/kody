import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deleteOauthAppIfUnused,
	getIntegration,
	listIntegrations,
	listOauthApps,
	rotateOauthAppClientCredentials,
	upsertIntegration,
} from './service.ts'

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
		sqlite,
		env: { APP_DB: createD1FromSqlite(sqlite) } as Pick<Env, 'APP_DB'>,
	}
}

const baseGoogleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	clientSecretSecretName: 'googleClientSecret',
	accessTokenSecretName: 'googleAccessToken',
	refreshTokenSecretName: 'googleRefreshToken',
	requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('upsertIntegration reuses an existing app when the full app tuple matches', async () => {
	const { env } = createEnv()
	const userId = 'user-upsert'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-calendar',
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['calendar.readonly'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
	})

	const apps = await listOauthApps({ env, userId })
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
	})

	const listed = await listIntegrations({ env, userId })
	expect(listed.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])
	expect(
		listed.every((entry) => entry.clientId === 'google-client-id-value'),
	).toBe(true)
})

test('upsertIntegration does not reuse an app when endpoints differ', async () => {
	const { env } = createEnv()
	const userId = 'user-upsert-split'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-legacy',
			tokenUrl: 'https://oauth2.googleapis.com/token/legacy',
			accessTokenSecretName: 'googleLegacyAccessToken',
			refreshTokenSecretName: 'googleLegacyRefreshToken',
		},
	})

	const apps = await listOauthApps({ env, userId })
	expect(apps).toHaveLength(2)
	expect(apps.map((app) => app.slug).sort()).toEqual([
		'google',
		'google-legacy',
	])
	expect(apps.find((app) => app.slug === 'google')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token',
	)
	expect(apps.find((app) => app.slug === 'google-legacy')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token/legacy',
	)

	const google = await getIntegration({ env, userId, name: 'google' })
	const legacy = await getIntegration({ env, userId, name: 'google-legacy' })
	expect(google?.tokenUrl).toBe('https://oauth2.googleapis.com/token')
	expect(legacy?.tokenUrl).toBe('https://oauth2.googleapis.com/token/legacy')
})

test('rotateOauthAppClientCredentials updates every sibling connection join', async () => {
	const { env } = createEnv()
	const userId = 'user-rotate'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-mail',
			accessTokenSecretName: 'googleMailAccessToken',
			refreshTokenSecretName: 'googleMailRefreshToken',
		},
	})

	const rotated = await rotateOauthAppClientCredentials({
		env,
		userId,
		slug: 'google',
		clientId: 'google-client-id-rotated',
		clientSecretSecretName: 'googleClientSecretRotated',
	})
	expect(rotated).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		clientSecretSecretName: 'googleClientSecretRotated',
	})

	const google = await getIntegration({ env, userId, name: 'google' })
	const googleMail = await getIntegration({ env, userId, name: 'google-mail' })
	expect(google?.clientId).toBe('google-client-id-rotated')
	expect(google?.clientSecretSecretName).toBe('googleClientSecretRotated')
	expect(googleMail?.clientId).toBe('google-client-id-rotated')
	expect(googleMail?.clientSecretSecretName).toBe('googleClientSecretRotated')
})

test('deleteOauthAppIfUnused is blocked while connections exist', async () => {
	const { env } = createEnv()
	const userId = 'user-delete-app'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})

	await expect(
		deleteOauthAppIfUnused({ env, userId, slug: 'google' }),
	).rejects.toThrow(/still has 1 connection/)

	const stillThere = await getIntegration({ env, userId, name: 'google' })
	expect(stillThere?.name).toBe('google')
})
