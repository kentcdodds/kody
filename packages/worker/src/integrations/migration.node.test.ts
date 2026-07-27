import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	normalizeIntegrationConfig,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { getJoinedIntegrationByName } from './repo.ts'
import {
	listOauthApps,
	toIntegrationConfig,
	upsertIntegration,
} from './service.ts'

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
	const normalized = normalizeIntegrationConfig({
		...rest,
		flow: rest.flow as IntegrationConfig['flow'],
		tokenExchangeStyle: rest.tokenExchangeStyle as
			| IntegrationConfig['tokenExchangeStyle']
			| undefined,
		clientId,
	})
	// buildOauthAppRow stores client secrets only for confidential apps; the
	// migrated row (and therefore toIntegrationConfig) matches that write rule.
	return {
		...normalized,
		clientSecretSecretName:
			normalized.flow === 'confidential'
				? (normalized.clientSecretSecretName ?? null)
				: null,
	}
}

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const oauthAppsMigration = '0101-user-oauth-apps-and-integrations.sql'

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

/** D1 wraps each migration file in a transaction. */
function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

function listIntegrationValueNames(db: DatabaseSync, userId: string) {
	return (
		db
			.prepare(
				`SELECT e.name
				FROM value_entries e
				INNER JOIN value_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = ? AND e.name GLOB '_integration:*'
				ORDER BY e.name ASC`,
			)
			.all(userId) as Array<{ name: string }>
	).map((row) => row.name)
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
		client_secret_secret_name: null,
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
			client_secret_secret_name: null,
			token_url: 'https://auth.example.com/oauth/token',
		},
		{
			slug: 'provider-beta',
			client_id: 'same-client-id',
			client_secret_secret_name: null,
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

test('0100 leaves empty-name and unresolved-clientId _integration values untouched', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-survive', userId: 'user-survive' })
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: 'real-client-id',
		value: 'real-client-id-value',
	})

	const migratable = {
		name: 'ok',
		tokenUrl: 'https://auth.example.com/oauth/token',
		apiBaseUrl: 'https://api.example.com',
		flow: 'pkce',
		clientIdValueName: 'real-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'okAccessToken',
		refreshTokenSecretName: null,
		requiredHosts: ['api.example.com'],
	}
	const emptyName = {
		...migratable,
		name: '',
		accessTokenSecretName: 'emptyAccessToken',
	}
	const missingClientId = {
		...migratable,
		name: 'missing-client',
		clientIdValueName: 'does-not-exist',
		accessTokenSecretName: 'missingAccessToken',
	}
	const emptyClientId = {
		...migratable,
		name: 'empty-client',
		clientIdValueName: 'blank-client-id',
		accessTokenSecretName: 'blankAccessToken',
	}

	insertValue(db, {
		bucketId: 'bucket-survive',
		name: 'blank-client-id',
		value: '   ',
	})
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: '_integration:ok',
		value: JSON.stringify(migratable),
	})
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: '_integration:',
		value: JSON.stringify(emptyName),
	})
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: '_integration:missing-client',
		value: JSON.stringify(missingClientId),
	})
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: '_integration:empty-client',
		value: JSON.stringify(emptyClientId),
	})
	insertValue(db, {
		bucketId: 'bucket-survive',
		name: '_integration:GitHub',
		value: JSON.stringify({ ...migratable, name: 'GitHub' }),
	})

	applyMigrationLikeD1(db, oauthAppsMigration)

	expect(listIntegrationValueNames(db, 'user-survive')).toEqual([
		'_integration:',
		'_integration:GitHub',
		'_integration:empty-client',
		'_integration:missing-client',
	])
	expect(
		db
			.prepare(
				`SELECT name FROM user_integrations
				WHERE user_id = 'user-survive'
				ORDER BY name ASC`,
			)
			.all(),
	).toEqual([{ name: 'ok' }])
	expect(
		db
			.prepare(
				`SELECT slug FROM user_oauth_apps
				WHERE user_id = 'user-survive'
				ORDER BY slug ASC`,
			)
			.all(),
	).toEqual([{ slug: 'ok' }])
})

test('0100 assertion abort rolls back and preserves _integration value rows', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-abort', userId: 'user-abort' })
	insertValue(db, {
		bucketId: 'bucket-abort',
		name: 'abort-client-id',
		value: 'abort-client-id-value',
	})
	insertValue(db, {
		bucketId: 'bucket-abort',
		name: '_integration:abort-me',
		value: JSON.stringify({
			name: 'abort-me',
			tokenUrl: 'https://auth.example.com/oauth/token',
			apiBaseUrl: 'https://api.example.com',
			flow: 'pkce',
			clientIdValueName: 'abort-client-id',
			clientSecretSecretName: null,
			accessTokenSecretName: 'abortAccessToken',
			refreshTokenSecretName: null,
			requiredHosts: ['api.example.com'],
		}),
	})

	const beforeIntegrationValues = listIntegrationValueNames(db, 'user-abort')
	expect(beforeIntegrationValues).toEqual(['_integration:abort-me'])

	// Force the post-delete "migratable rows remain" assertion to fire by
	// ignoring deletes of `_integration:*` values. Created outside the
	// migration transaction so the ignore survives until rollback.
	db.exec(`
		CREATE TRIGGER test_keep_integration_values
		BEFORE DELETE ON value_entries
		WHEN OLD.name GLOB '_integration:*'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)

	expect(() => applyMigrationLikeD1(db, oauthAppsMigration)).toThrow(
		/CHECK constraint failed: 0/,
	)

	expect(listIntegrationValueNames(db, 'user-abort')).toEqual(
		beforeIntegrationValues,
	)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN (
						'user_oauth_apps',
						'user_integrations',
						'__migration_0100_source',
						'__migration_0100_app_groups',
						'__migration_assertions'
					)`,
			)
			.all(),
	).toEqual([])
})

test('0101 stores use_pkce matching normalizeIntegrationConfig flow defaults', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-pkce', userId: 'user-pkce' })
	insertValue(db, {
		bucketId: 'bucket-pkce',
		name: 'shared-client-id',
		value: 'shared-client-id-value',
	})

	const cases: Array<{
		name: string
		flow: 'pkce' | 'confidential'
		usePkce: boolean
		expectedUsePkce: number | null
	}> = [
		{
			name: 'flow-pkce-default-on',
			flow: 'pkce',
			usePkce: true,
			expectedUsePkce: null,
		},
		{
			name: 'flow-pkce-explicit-off',
			flow: 'pkce',
			usePkce: false,
			expectedUsePkce: 0,
		},
		{
			name: 'flow-confidential-default-off',
			flow: 'confidential',
			usePkce: false,
			expectedUsePkce: null,
		},
		{
			name: 'flow-confidential-explicit-on',
			flow: 'confidential',
			usePkce: true,
			expectedUsePkce: 1,
		},
	]

	for (const entry of cases) {
		insertValue(db, {
			bucketId: 'bucket-pkce',
			name: `_integration:${entry.name}`,
			value: JSON.stringify({
				name: entry.name,
				tokenUrl: 'https://auth.example.com/oauth/token',
				apiBaseUrl: 'https://api.example.com',
				flow: entry.flow,
				usePkce: entry.usePkce,
				clientIdValueName: 'shared-client-id',
				clientSecretSecretName: `${entry.name}Secret`,
				accessTokenSecretName: `${entry.name}AccessToken`,
				refreshTokenSecretName: null,
				requiredHosts: ['api.example.com'],
			}),
		})
	}

	applyMigration(db, oauthAppsMigration)

	const rows = db
		.prepare(
			`SELECT slug, flow, use_pkce
			FROM user_oauth_apps
			WHERE user_id = 'user-pkce'
			ORDER BY slug ASC`,
		)
		.all() as Array<{
		slug: string
		flow: string
		use_pkce: number | null
	}>

	expect(rows).toEqual(
		cases
			.map((entry) => ({
				slug: entry.name,
				flow: entry.flow,
				use_pkce: entry.expectedUsePkce,
			}))
			.sort((left, right) => left.slug.localeCompare(right.slug)),
	)
})

test('0101 canonicalizes extra_authorize_params_json key order for tuple matching', async () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, oauthAppsMigration)

	insertUserBucket(db, { bucketId: 'bucket-params', userId: 'user-params' })
	insertValue(db, {
		bucketId: 'bucket-params',
		name: 'google-client-id',
		value: 'google-client-id-value',
	})

	// Deliberately reverse-sorted keys — not what JSON.stringify of the
	// normalized object would produce.
	const reverseSortedParams = {
		prompt: 'consent',
		include_granted_scopes: 'true',
		access_type: 'offline',
	}
	const sortedParamsJson = JSON.stringify({
		access_type: 'offline',
		include_granted_scopes: 'true',
		prompt: 'consent',
	})
	expect(JSON.stringify(reverseSortedParams)).not.toBe(sortedParamsJson)

	insertValue(db, {
		bucketId: 'bucket-params',
		name: '_integration:google',
		value: JSON.stringify({
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientIdValueName: 'google-client-id',
			clientSecretSecretName: 'googleClientSecret',
			accessTokenSecretName: 'googleAccessToken',
			refreshTokenSecretName: 'googleRefreshToken',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['openid', 'email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: reverseSortedParams,
			},
		}),
	})

	// Empty / absent shapes must all store '{}'. Distinct token URLs keep
	// each case on its own app so we can assert the raw column per slug.
	const emptyShapes: Array<{
		name: string
		tokenUrl: string
		authorization?: {
			authorizeUrl: string
			scopes: Array<string>
			extraAuthorizeParams?: Record<string, string>
		}
	}> = [
		{
			name: 'params-no-authorization',
			tokenUrl: 'https://auth.example.com/token/no-auth',
		},
		{
			name: 'params-no-extra',
			tokenUrl: 'https://auth.example.com/token/no-extra',
			authorization: {
				authorizeUrl: 'https://auth.example.com/a',
				scopes: [],
			},
		},
		{
			name: 'params-explicit-empty',
			tokenUrl: 'https://auth.example.com/token/explicit-empty',
			authorization: {
				authorizeUrl: 'https://auth.example.com/a',
				scopes: [],
				extraAuthorizeParams: {},
			},
		},
	]
	insertValue(db, {
		bucketId: 'bucket-params',
		name: 'empty-client-id',
		value: 'empty-client-id-value',
	})
	for (const entry of emptyShapes) {
		insertValue(db, {
			bucketId: 'bucket-params',
			name: `_integration:${entry.name}`,
			value: JSON.stringify({
				name: entry.name,
				tokenUrl: entry.tokenUrl,
				flow: 'pkce',
				clientIdValueName: 'empty-client-id',
				accessTokenSecretName: `${entry.name}AccessToken`,
				requiredHosts: ['auth.example.com'],
				...(entry.authorization ? { authorization: entry.authorization } : {}),
			}),
		})
	}

	applyMigration(db, oauthAppsMigration)

	const googleRow = db
		.prepare(
			`SELECT slug, extra_authorize_params_json, scope_separator,
				client_secret_secret_name, token_exchange_style
			FROM user_oauth_apps
			WHERE user_id = 'user-params' AND slug = 'google'`,
		)
		.get() as {
		slug: string
		extra_authorize_params_json: string
		scope_separator: string | null
		client_secret_secret_name: string | null
		token_exchange_style: string | null
	}

	// Assert the raw column — round-tripping through normalize would hide
	// unsorted storage.
	expect(googleRow.extra_authorize_params_json).toBe(sortedParamsJson)
	expect(googleRow.scope_separator).toBeNull()
	expect(googleRow.client_secret_secret_name).toBeNull()
	expect(googleRow.token_exchange_style).toBeNull()

	const emptyRows = db
		.prepare(
			`SELECT slug, extra_authorize_params_json
			FROM user_oauth_apps
			WHERE user_id = 'user-params' AND slug LIKE 'params-%'
			ORDER BY slug ASC`,
		)
		.all() as Array<{ slug: string; extra_authorize_params_json: string }>
	expect(emptyRows).toEqual([
		{
			slug: 'params-explicit-empty',
			extra_authorize_params_json: '{}',
		},
		{
			slug: 'params-no-authorization',
			extra_authorize_params_json: '{}',
		},
		{
			slug: 'params-no-extra',
			extra_authorize_params_json: '{}',
		},
	])

	// The consequence being prevented: a sibling upsert must reuse the
	// migrated app rather than allocating a new slug.
	const env = { APP_DB: createD1FromSqlite(db) } as Pick<Env, 'APP_DB'>
	await upsertIntegration({
		env,
		userId: 'user-params',
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'google-client-id-value',
			accessTokenSecretName: 'googleCalendarAccessToken',
			refreshTokenSecretName: 'googleCalendarRefreshToken',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['calendar.readonly'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {
					access_type: 'offline',
					include_granted_scopes: 'true',
					prompt: 'consent',
				},
			},
		},
	})

	const apps = await listOauthApps({ env, userId: 'user-params' })
	const googleFamily = apps.filter((app) => app.provider === 'google')
	expect(googleFamily).toHaveLength(1)
	expect(googleFamily[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
	})
})
