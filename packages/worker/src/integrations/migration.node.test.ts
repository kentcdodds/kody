import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	normalizeIntegrationConfig,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { getJoinedIntegrationByName } from './repo.ts'
import { toIntegrationConfig } from './service.ts'

/** Historical `_integration:*` value blob shape (pre-0100), with client id as a sibling value name. */
type LegacyIntegrationValue = {
	name: string
	tokenUrl?: string
	apiBaseUrl?: string | null
	flow: string
	usePkce?: boolean | null
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	tokenExchangeStyle?: string | null
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
}

function expectedConfigFromLegacy(
	legacy: LegacyIntegrationValue,
	clientId: string,
): IntegrationConfig {
	const { clientIdValueName: _ignored, ...rest } = legacy
	return normalizeIntegrationConfig({
		...rest,
		flow: rest.flow as IntegrationConfig['flow'],
		tokenExchangeStyle: rest.tokenExchangeStyle as
			| IntegrationConfig['tokenExchangeStyle']
			| undefined,
		clientId,
	})
}

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const oauthAppsMigration = '0100-user-oauth-apps-and-integrations.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function insertUserBucket(
	db: DatabaseSync,
	input: { bucketId: string; userId: string },
) {
	db.prepare(
		`INSERT INTO value_buckets (
			id, user_id, scope, binding_key, expires_at, created_at, updated_at
		) VALUES (?, ?, 'user', '', NULL, ?, ?)`,
	).run(
		input.bucketId,
		input.userId,
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z',
	)
}

function insertValue(
	db: DatabaseSync,
	input: {
		bucketId: string
		name: string
		value: string
		description?: string
	},
) {
	db.prepare(
		`INSERT INTO value_entries (
			bucket_id, name, description, value, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		input.bucketId,
		input.name,
		input.description ?? '',
		input.value,
		'2026-02-01T00:00:00.000Z',
		'2026-02-02T00:00:00.000Z',
	)
}

function nHosts(count: number) {
	return Array.from({ length: count }, (_, index) => `host${index}.example.com`)
}

function nScopes(count: number) {
	return Array.from({ length: count }, (_, index) => `scope.${index}`)
}

function googleLegacyConfig(input: {
	name: string
	scopeCount: number
	hostCount: number
	accessTokenSecretName: string
	refreshTokenSecretName: string
}): LegacyIntegrationValue {
	return {
		name: input.name,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce',
		clientIdValueName: 'google-client-id',
		clientSecretSecretName: 'googleClientSecret',
		accessTokenSecretName: input.accessTokenSecretName,
		refreshTokenSecretName: input.refreshTokenSecretName,
		requiredHosts: nHosts(input.hostCount),
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: nScopes(input.scopeCount),
			scopeSeparator: ' ',
			extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
		},
	}
}

function expectedClientId(name: string) {
	if (name.startsWith('google')) return 'google-client-id-value'
	if (name.startsWith('github')) return 'shared-github-client-id'
	if (name.startsWith('x')) return 'x-client-id-value'
	return 'tesla-client-id-value'
}

test('0100 migrates oauth apps/connections with production-shaped dedupe fixtures', async () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-a', userId: 'user-a' })
	insertUserBucket(db, { bucketId: 'bucket-b', userId: 'user-b' })

	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'google-client-id',
		value: 'google-client-id-value',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'github-client-id',
		value: 'shared-github-client-id',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'x-client-id',
		value: 'x-client-id-value',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'tesla-client-id',
		value: 'tesla-client-id-value',
	})
	insertValue(db, {
		bucketId: 'bucket-b',
		name: 'google-client-id',
		value: 'google-client-id-value',
	})

	const googleFixtures: Array<LegacyIntegrationValue> = [
		googleLegacyConfig({
			name: 'google',
			scopeCount: 11,
			hostCount: 10,
			accessTokenSecretName: 'googleAccessToken',
			refreshTokenSecretName: 'googleRefreshToken',
		}),
		googleLegacyConfig({
			name: 'google-calendar',
			scopeCount: 12,
			hostCount: 10,
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
		}),
		googleLegacyConfig({
			name: 'google-mail',
			scopeCount: 6,
			hostCount: 7,
			accessTokenSecretName: 'googleMailAccessToken',
			refreshTokenSecretName: 'googleMailRefreshToken',
		}),
		googleLegacyConfig({
			name: 'google-drive',
			scopeCount: 6,
			hostCount: 7,
			accessTokenSecretName: 'googleDriveAccessToken',
			refreshTokenSecretName: 'googleDriveRefreshToken',
		}),
	]

	const github: LegacyIntegrationValue = {
		name: 'github',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential',
		clientIdValueName: 'github-client-id',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: null,
		requiredHosts: ['github.com', 'api.github.com'],
	}
	const githubKent: LegacyIntegrationValue = {
		...github,
		name: 'github-kent',
		clientSecretSecretName: 'githubKentClientSecret',
		accessTokenSecretName: 'githubKentAccessToken',
	}

	const xConfig: LegacyIntegrationValue = {
		name: 'x',
		tokenUrl: 'https://api.twitter.com/2/oauth2/token',
		apiBaseUrl: 'https://api.twitter.com',
		flow: 'pkce',
		clientIdValueName: 'x-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'xAccessToken',
		refreshTokenSecretName: 'xRefreshToken',
		requiredHosts: ['api.twitter.com', 'twitter.com'],
		authorization: {
			authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
			scopes: ['tweet.read', 'users.read'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	}
	const xKodykoala: LegacyIntegrationValue = {
		...xConfig,
		name: 'x-kodykoala',
		accessTokenSecretName: 'xKodykoalaAccessToken',
		refreshTokenSecretName: 'xKodykoalaRefreshToken',
		authorization: {
			authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
			scopes: ['tweet.read'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	}

	const tesla: LegacyIntegrationValue = {
		name: 'tesla',
		tokenUrl: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
		apiBaseUrl: 'https://fleet-api.prd.vn.cloud.tesla.com',
		flow: 'pkce',
		clientIdValueName: 'tesla-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'teslaAccessToken',
		refreshTokenSecretName: 'teslaRefreshToken',
		requiredHosts: ['fleet-api.prd.vn.cloud.tesla.com'],
	}

	// Intentionally missing tokenUrl so 0100 leaves this non-migratable row alone.
	const malformed = {
		name: 'broken',
		apiBaseUrl: 'https://example.com',
		flow: 'pkce',
		clientIdValueName: 'google-client-id',
		accessTokenSecretName: 'brokenAccessToken',
		requiredHosts: ['example.com'],
	}

	const userAConfigs = [
		...googleFixtures,
		github,
		githubKent,
		xConfig,
		xKodykoala,
		tesla,
	]
	for (const config of userAConfigs) {
		insertValue(db, {
			bucketId: 'bucket-a',
			name: `_integration:${config.name}`,
			value: JSON.stringify(config),
		})
	}
	insertValue(db, {
		bucketId: 'bucket-a',
		name: '_integration:broken',
		value: JSON.stringify(malformed),
	})

	const userBGoogle = googleLegacyConfig({
		name: 'google',
		scopeCount: 11,
		hostCount: 10,
		accessTokenSecretName: 'userBGoogleAccessToken',
		refreshTokenSecretName: 'userBGoogleRefreshToken',
	})
	insertValue(db, {
		bucketId: 'bucket-b',
		name: '_integration:google',
		value: JSON.stringify(userBGoogle),
	})

	const expectedByKey = new Map<string, IntegrationConfig>()
	for (const config of [...userAConfigs, userBGoogle]) {
		const userId = config === userBGoogle ? 'user-b' : 'user-a'
		expectedByKey.set(
			`${userId}:${config.name}`,
			expectedConfigFromLegacy(config, expectedClientId(config.name)),
		)
	}

	applyMigration(db, oauthAppsMigration)

	const apps = db
		.prepare(
			`SELECT user_id, slug, client_id, client_secret_secret_name, authorize_url
			FROM user_oauth_apps
			ORDER BY user_id ASC, slug ASC`,
		)
		.all() as Array<{
		user_id: string
		slug: string
		client_id: string
		client_secret_secret_name: string | null
		authorize_url: string | null
	}>

	const connections = db
		.prepare(
			`SELECT user_id, name, app_slug, scopes_json, required_hosts_json,
				access_token_secret_name, refresh_token_secret_name
			FROM user_integrations
			ORDER BY user_id ASC, name ASC`,
		)
		.all() as Array<{
		user_id: string
		name: string
		app_slug: string
		scopes_json: string
		required_hosts_json: string
		access_token_secret_name: string
		refresh_token_secret_name: string | null
	}>

	const userAApps = apps.filter((row) => row.user_id === 'user-a')
	expect(userAApps.map((row) => row.slug).sort()).toEqual([
		'github',
		'github-kent',
		'google',
		'tesla',
		'x',
	])

	expect(userAApps.find((row) => row.slug === 'google')).toMatchObject({
		client_id: 'google-client-id-value',
		client_secret_secret_name: 'googleClientSecret',
		authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
	})

	const userAGoogleConnections = connections.filter(
		(row) => row.user_id === 'user-a' && row.app_slug === 'google',
	)
	expect(userAGoogleConnections).toHaveLength(4)
	expect(
		userAGoogleConnections.map((row) => ({
			name: row.name,
			scopes: (JSON.parse(row.scopes_json) as Array<unknown>).length,
			hosts: (JSON.parse(row.required_hosts_json) as Array<unknown>).length,
			access: row.access_token_secret_name,
		})),
	).toEqual([
		{
			name: 'google',
			scopes: 11,
			hosts: 10,
			access: 'googleAccessToken',
		},
		{
			name: 'google-calendar',
			scopes: 12,
			hosts: 10,
			access: 'googleCalendarAccessToken',
		},
		{
			name: 'google-drive',
			scopes: 6,
			hosts: 7,
			access: 'googleDriveAccessToken',
		},
		{
			name: 'google-mail',
			scopes: 6,
			hosts: 7,
			access: 'googleMailAccessToken',
		},
	])

	expect(
		userAApps.filter((row) => row.client_id === 'shared-github-client-id'),
	).toHaveLength(2)
	expect(
		userAApps.find((row) => row.slug === 'github')?.client_secret_secret_name,
	).toBe('githubClientSecret')
	expect(
		userAApps.find((row) => row.slug === 'github-kent')
			?.client_secret_secret_name,
	).toBe('githubKentClientSecret')

	expect(userAApps.find((row) => row.slug === 'x')).toMatchObject({
		client_id: 'x-client-id-value',
		client_secret_secret_name: null,
	})
	expect(
		connections.filter(
			(row) => row.user_id === 'user-a' && row.app_slug === 'x',
		),
	).toHaveLength(2)

	expect(
		userAApps.find((row) => row.slug === 'tesla')?.authorize_url,
	).toBeNull()

	const survivingValues = db
		.prepare(
			`SELECT e.name
			FROM value_entries e
			INNER JOIN value_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = 'user-a'
			ORDER BY e.name ASC`,
		)
		.all() as Array<{ name: string }>
	expect(survivingValues.map((row) => row.name)).toEqual([
		'_integration:broken',
		'github-client-id',
		'google-client-id',
		'tesla-client-id',
		'x-client-id',
	])

	expect(apps.filter((row) => row.user_id === 'user-b')).toEqual([
		expect.objectContaining({
			user_id: 'user-b',
			slug: 'google',
			client_id: 'google-client-id-value',
		}),
	])
	expect(
		connections
			.filter((row) => row.user_id === 'user-b')
			.map((row) => row.name),
	).toEqual(['google'])

	const d1 = createD1FromSqlite(db)
	for (const [key, expected] of expectedByKey) {
		const [userId, name] = key.split(':') as [string, string]
		const joined = await getJoinedIntegrationByName({
			db: d1,
			userId,
			name,
		})
		expect(joined).not.toBeNull()
		if (!joined) continue
		expect(toIntegrationConfig(joined.app, joined.connection)).toEqual(expected)
	}

	const userAListed = await getJoinedIntegrationByName({
		db: d1,
		userId: 'user-a',
		name: 'google',
	})
	expect(userAListed?.connection.accessTokenSecretName).toBe(
		'googleAccessToken',
	)
	const userBListed = await getJoinedIntegrationByName({
		db: d1,
		userId: 'user-b',
		name: 'google',
	})
	expect(userBListed?.connection.accessTokenSecretName).toBe(
		'userBGoogleAccessToken',
	)
	expect(userAListed?.app.userId).toBe('user-a')
	expect(userBListed?.app.userId).toBe('user-b')

	// Production shared-app shape still holds under full-tuple dedupe:
	// google→1 app/4 connections, x→1 app/2, github→2 apps (secret names differ),
	// plus singletons. That account's 11 singletons + these groups = 15 apps / 19
	// connections when every shared group agrees on app-level fields.
	expect(userAApps).toHaveLength(5)
	expect(connections.filter((row) => row.user_id === 'user-a')).toHaveLength(9)
})

test('0100 splits apps when credentials match but token_url differs', async () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-split', userId: 'user-split' })
	insertValue(db, {
		bucketId: 'bucket-split',
		name: 'shared-client-id',
		value: 'same-client-id',
	})

	const left: LegacyIntegrationValue = {
		name: 'provider-alpha',
		tokenUrl: 'https://auth.example.com/oauth/token',
		apiBaseUrl: 'https://api.example.com',
		flow: 'pkce',
		clientIdValueName: 'shared-client-id',
		clientSecretSecretName: 'sharedClientSecret',
		accessTokenSecretName: 'alphaAccessToken',
		refreshTokenSecretName: 'alphaRefreshToken',
		requiredHosts: ['api.example.com'],
		authorization: {
			authorizeUrl: 'https://auth.example.com/oauth/authorize',
			scopes: ['read'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	}
	const right: LegacyIntegrationValue = {
		...left,
		name: 'provider-beta',
		tokenUrl: 'https://auth.example.com/oauth/v2/token',
		accessTokenSecretName: 'betaAccessToken',
		refreshTokenSecretName: 'betaRefreshToken',
		authorization: {
			authorizeUrl: 'https://auth.example.com/oauth/authorize',
			scopes: ['write'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	}

	for (const config of [left, right]) {
		insertValue(db, {
			bucketId: 'bucket-split',
			name: `_integration:${config.name}`,
			value: JSON.stringify(config),
		})
	}

	applyMigration(db, oauthAppsMigration)

	const apps = db
		.prepare(
			`SELECT slug, client_id, client_secret_secret_name, token_url
			FROM user_oauth_apps
			WHERE user_id = 'user-split'
			ORDER BY slug ASC`,
		)
		.all() as Array<{
		slug: string
		client_id: string
		client_secret_secret_name: string | null
		token_url: string
	}>
	expect(apps).toEqual([
		{
			slug: 'provider-alpha',
			client_id: 'same-client-id',
			client_secret_secret_name: 'sharedClientSecret',
			token_url: 'https://auth.example.com/oauth/token',
		},
		{
			slug: 'provider-beta',
			client_id: 'same-client-id',
			client_secret_secret_name: 'sharedClientSecret',
			token_url: 'https://auth.example.com/oauth/v2/token',
		},
	])

	const connections = db
		.prepare(
			`SELECT name, app_slug
			FROM user_integrations
			WHERE user_id = 'user-split'
			ORDER BY name ASC`,
		)
		.all() as Array<{ name: string; app_slug: string }>
	expect(connections).toEqual([
		{ name: 'provider-alpha', app_slug: 'provider-alpha' },
		{ name: 'provider-beta', app_slug: 'provider-beta' },
	])

	const d1 = createD1FromSqlite(db)
	const alpha = await getJoinedIntegrationByName({
		db: d1,
		userId: 'user-split',
		name: 'provider-alpha',
	})
	const beta = await getJoinedIntegrationByName({
		db: d1,
		userId: 'user-split',
		name: 'provider-beta',
	})
	expect(alpha?.app.tokenUrl).toBe('https://auth.example.com/oauth/token')
	expect(beta?.app.tokenUrl).toBe('https://auth.example.com/oauth/v2/token')
	expect(toIntegrationConfig(alpha!.app, alpha!.connection).tokenUrl).toBe(
		'https://auth.example.com/oauth/token',
	)
	expect(toIntegrationConfig(beta!.app, beta!.connection).tokenUrl).toBe(
		'https://auth.example.com/oauth/v2/token',
	)
})
