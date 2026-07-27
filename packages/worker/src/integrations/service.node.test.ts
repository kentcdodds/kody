import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deleteOauthAppIfUnused,
	getIntegration,
	getOauthApp,
	listIntegrations,
	listOauthApps,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
	upsertIntegration,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const oauthAppsMigration = '0101-user-oauth-apps-and-integrations.sql'

function applyAllMigrations(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
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

test('upsertIntegration reuses a migrated confidential app that stored usePkce false as NULL', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, oauthAppsMigration)
	sqlite
		.prepare(
			`INSERT INTO value_buckets (
				id, user_id, scope, binding_key, expires_at, created_at, updated_at
			) VALUES (?, ?, 'user', '', NULL, ?, ?)`,
		)
		.run(
			'bucket-reuse',
			'user-reuse',
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
		)
	sqlite
		.prepare(
			`INSERT INTO value_entries (
				bucket_id, name, description, value, created_at, updated_at
			) VALUES (?, ?, '', ?, ?, ?)`,
		)
		.run(
			'bucket-reuse',
			'canva-client-id',
			'canva-client-id-value',
			'2026-02-01T00:00:00.000Z',
			'2026-02-02T00:00:00.000Z',
		)
	sqlite
		.prepare(
			`INSERT INTO value_entries (
				bucket_id, name, description, value, created_at, updated_at
			) VALUES (?, ?, '', ?, ?, ?)`,
		)
		.run(
			'bucket-reuse',
			'_integration:canva',
			JSON.stringify({
				name: 'canva',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				apiBaseUrl: 'https://api.canva.com',
				flow: 'confidential',
				usePkce: false,
				clientIdValueName: 'canva-client-id',
				clientSecretSecretName: 'canvaClientSecret',
				accessTokenSecretName: 'canvaAccessToken',
				refreshTokenSecretName: 'canvaRefreshToken',
				requiredHosts: ['api.canva.com'],
				tokenExchangeStyle: 'basic-form',
			}),
			'2026-02-01T00:00:00.000Z',
			'2026-02-02T00:00:00.000Z',
		)
	sqlite.exec(
		readFileSync(new URL(oauthAppsMigration, migrationsDirectory), 'utf8'),
	)

	const stored = sqlite
		.prepare(
			`SELECT slug, flow, use_pkce FROM user_oauth_apps WHERE user_id = ?`,
		)
		.get('user-reuse') as {
		slug: string
		flow: string
		use_pkce: number | null
	}
	expect(stored).toEqual({
		slug: 'canva',
		flow: 'confidential',
		use_pkce: null,
	})

	const env = { APP_DB: createD1FromSqlite(sqlite) } as Pick<Env, 'APP_DB'>
	await upsertIntegration({
		env,
		userId: 'user-reuse',
		config: {
			name: 'canva-team',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com',
			flow: 'confidential',
			usePkce: false,
			clientId: 'canva-client-id-value',
			clientSecretSecretName: 'canvaClientSecret',
			accessTokenSecretName: 'canvaTeamAccessToken',
			refreshTokenSecretName: 'canvaTeamRefreshToken',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
		},
	})

	const apps = await listOauthApps({ env, userId: 'user-reuse' })
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'canva',
		connectionCount: 2,
		usePkce: null,
		flow: 'confidential',
	})
	const joined = await listJoinedIntegrations({ env, userId: 'user-reuse' })
	expect(joined.map(({ connection }) => connection.name).sort()).toEqual([
		'canva',
		'canva-team',
	])
	expect(joined.every(({ app }) => app.slug === 'canva')).toBe(true)
})

test('getOauthApp and rotateOauthAppClientCredentials canonicalize mixed-case slugs', async () => {
	const { env } = createEnv()
	const userId = 'user-slug-case'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})

	const found = await getOauthApp({ env, userId, slug: 'Google' })
	expect(found).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-value',
	})

	const rotated = await rotateOauthAppClientCredentials({
		env,
		userId,
		slug: ' Google ',
		clientId: 'google-client-id-rotated',
		clientSecretSecretName: 'googleClientSecretRotated',
	})
	expect(rotated).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		clientSecretSecretName: 'googleClientSecretRotated',
	})

	await expect(
		deleteOauthAppIfUnused({ env, userId, slug: 'GOOGLE' }),
	).rejects.toThrow(/still has 1 connection/)
})
