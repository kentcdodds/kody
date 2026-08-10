import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'
import {
	deleteIntegration,
	deleteOauthAppIfUnused,
	findOauthAppForProviderSetup,
	getAvailablePlatformApp,
	getIntegration,
	getOauthApp,
	listAvailablePlatformApps,
	listIntegrations,
	listOauthApps,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
	upsertIntegration,
	upsertOauthAppWithoutConnection,
	upsertPlatformIntegration,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	applyRepositoryMigrations(db, migrationsDirectory)
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
	clientSecretSecretName: null as string | null,
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

test('upsertIntegration normalizes URL-shaped required hosts to bare hostnames', async () => {
	const { env } = createEnv()
	const userId = 'user-hosts'

	const saved = await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			requiredHosts: [
				'https://www.googleapis.com',
				'HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2',
				'oauth2.googleapis.com',
			],
		},
	})
	expect(saved.requiredHosts).toEqual([
		'accounts.google.com',
		'oauth2.googleapis.com',
		'www.googleapis.com',
	])
})

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

test('upsertIntegration reuses a confidential app that stored usePkce false as NULL', async () => {
	const { env, sqlite } = createEnv()
	const now = '2026-02-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, label, client_id, client_secret_secret_name,
				token_url, authorize_url, api_base_url, flow, use_pkce,
				token_exchange_style, scope_separator, extra_authorize_params_json,
				created_at, updated_at
			) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'confidential', NULL, ?, NULL, '{}', ?, ?)`,
		)
		.run(
			'user-reuse',
			'canva',
			'canva',
			'canva-client-id-value',
			'canvaClientSecret',
			'https://api.canva.com/rest/v1/oauth/token',
			'https://api.canva.com',
			'basic-form',
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, account_label, description, scopes_json,
				required_hosts_json, access_token_secret_name, refresh_token_secret_name,
				connected_at, token_refreshed_at, created_at, updated_at
			) VALUES (?, ?, ?, NULL, '', '[]', ?, ?, ?, NULL, NULL, ?, ?)`,
		)
		.run(
			'user-reuse',
			'canva',
			'canva',
			JSON.stringify(['api.canva.com']),
			'canvaAccessToken',
			'canvaRefreshToken',
			now,
			now,
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

test('reusing a matched app does not rewrite provider or other app identity fields', async () => {
	const { env, sqlite } = createEnv()
	const userId = 'user-provider-preserve'

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
		},
	})

	const before = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(userId) as {
		slug: string
		provider: string
		label: string | null
		client_id: string
		token_url: string
		created_at: string
		updated_at: string
	}
	expect(before.provider).toBe('google')

	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'acme-thing',
			accessTokenSecretName: 'acmeAccessToken',
			refreshTokenSecretName: 'acmeRefreshToken',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['acme.scope'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
	})

	const after = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(userId) as typeof before

	expect(after).toEqual(before)
	expect(after.provider).toBe('google')

	const apps = await listOauthApps({ env, userId })
	expect(apps).toHaveLength(1)
	expect(apps[0]?.connectionCount).toBe(3)
})

test('moving the last connection off an app deletes the orphan app row', async () => {
	const { env, sqlite } = createEnv()
	const userId = 'user-orphan'

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
			name: 'solo-app',
			clientId: 'solo-client-id',
			clientSecretSecretName: 'soloClientSecret',
			accessTokenSecretName: 'soloAccessToken',
			refreshTokenSecretName: 'soloRefreshToken',
		},
	})
	expect(
		sqlite
			.prepare(
				`SELECT slug FROM user_oauth_apps WHERE user_id = ? ORDER BY slug`,
			)
			.all(userId),
	).toEqual([{ slug: 'google' }, { slug: 'solo-app' }])

	// Rematch solo-app onto the google app tuple → previous solo app is orphaned.
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'solo-app',
			accessTokenSecretName: 'soloAccessToken',
			refreshTokenSecretName: 'soloRefreshToken',
		},
	})

	expect(
		sqlite
			.prepare(
				`SELECT slug FROM user_oauth_apps WHERE user_id = ? ORDER BY slug`,
			)
			.all(userId),
	).toEqual([{ slug: 'google' }])
	expect(
		sqlite
			.prepare(
				`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? ORDER BY name`,
			)
			.all(userId),
	).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'solo-app', app_slug: 'google' },
	])
})

test('moving a non-last connection off an app leaves siblings intact', async () => {
	const { env, sqlite } = createEnv()
	const userId = 'user-sibling-keep'

	for (const name of [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const) {
		await upsertIntegration({
			env,
			userId,
			config: {
				...baseGoogleConfig,
				name,
				accessTokenSecretName: `${name}AccessToken`,
				refreshTokenSecretName: `${name}RefreshToken`,
				authorization: {
					...baseGoogleConfig.authorization,
					scopes: name === 'google' ? ['openid', 'email'] : [`${name}.scope`],
				},
			},
		})
	}

	expect(
		(
			sqlite
				.prepare(
					`SELECT count(*) AS count FROM user_integrations
					WHERE user_id = ? AND app_slug = 'google'`,
				)
				.get(userId) as { count: number }
		).count,
	).toBe(4)

	// Move one connection to a different app tuple; the google app keeps 3.
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-drive',
			tokenUrl: 'https://oauth2.googleapis.com/token/other',
			accessTokenSecretName: 'googleDriveAccessToken',
			refreshTokenSecretName: 'googleDriveRefreshToken',
		},
	})

	const googleApp = sqlite
		.prepare(
			`SELECT slug, provider FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(userId) as { slug: string; provider: string }
	expect(googleApp).toEqual({ slug: 'google', provider: 'google' })
	expect(
		(
			sqlite
				.prepare(
					`SELECT count(*) AS count FROM user_integrations
					WHERE user_id = ? AND app_slug = 'google'`,
				)
				.get(userId) as { count: number }
		).count,
	).toBe(3)
	expect(
		sqlite
			.prepare(
				`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? AND name = 'google-drive'`,
			)
			.get(userId),
	).toEqual({ name: 'google-drive', app_slug: 'google-drive' })
})

test('re-saving one of four shared connections with new scopes keeps the shared app', async () => {
	const { env, sqlite } = createEnv()
	const userId = 'user-four-shared'

	const names = [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const
	for (const name of names) {
		await upsertIntegration({
			env,
			userId,
			config: {
				...baseGoogleConfig,
				name,
				accessTokenSecretName: `${name}AccessToken`,
				refreshTokenSecretName: `${name}RefreshToken`,
				authorization: {
					...baseGoogleConfig.authorization,
					scopes: [`${name}.initial`],
				},
				requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
			},
		})
	}

	const beforeApp = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		)
		.get(userId)

	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-mail',
			accessTokenSecretName: 'googleMailAccessToken',
			refreshTokenSecretName: 'googleMailRefreshToken',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['gmail.modify', 'gmail.readonly'],
			},
			requiredHosts: ['gmail.googleapis.com'],
		},
	})

	const afterApp = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		)
		.get(userId)
	expect(afterApp).toEqual(beforeApp)

	const connections = sqlite
		.prepare(
			`SELECT name, app_slug, scopes_json, required_hosts_json
			FROM user_integrations WHERE user_id = ? ORDER BY name`,
		)
		.all(userId) as Array<{
		name: string
		app_slug: string
		scopes_json: string
		required_hosts_json: string
	}>
	expect(connections).toHaveLength(4)
	expect(connections.every((row) => row.app_slug === 'google')).toBe(true)
	expect(connections.find((row) => row.name === 'google-mail')).toMatchObject({
		scopes_json: JSON.stringify(['gmail.modify', 'gmail.readonly']),
		required_hosts_json: JSON.stringify(['gmail.googleapis.com']),
	})
})

test('upsertOauthAppWithoutConnection covers setup, client-id reuse, and connected-app preservation', async () => {
	const { env, sqlite } = createEnv()
	const setupUserId = 'user-setup-then-connect'

	const app = await upsertOauthAppWithoutConnection({
		env,
		userId: setupUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			usePkce: true,
			clientId: 'spotify-client-from-setup',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(app).toMatchObject({
		slug: 'spotify',
		clientId: 'spotify-client-from-setup',
		flow: 'pkce',
	})
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({
			slug: 'spotify',
			connectionCount: 0,
			clientId: 'spotify-client-from-setup',
		}),
	])
	expect(await listIntegrations({ env, userId: setupUserId })).toEqual([])

	await upsertIntegration({
		env,
		userId: setupUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientId: 'spotify-client-from-setup',
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({
			slug: 'spotify',
			connectionCount: 1,
			clientId: 'spotify-client-from-setup',
		}),
	])

	const notionUserId = 'user-setup-orphan-reuse'
	await upsertOauthAppWithoutConnection({
		env,
		userId: notionUserId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-old',
			clientSecretSecretName: 'notionClientSecret',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	const updated = await upsertOauthAppWithoutConnection({
		env,
		userId: notionUserId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-new',
			clientSecretSecretName: 'notionClientSecret',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	expect(updated).toMatchObject({
		slug: 'notion',
		clientId: 'notion-client-new',
	})
	expect(await listOauthApps({ env, userId: notionUserId })).toHaveLength(1)

	const preserveUserId = 'user-setup-preserve'
	await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			accessTokenSecretName: 'googleAccessToken',
			refreshTokenSecretName: 'googleRefreshToken',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['openid', 'email'],
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	const before = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(preserveUserId) as {
		slug: string
		provider: string
		label: string | null
		client_id: string
		token_url: string
		created_at: string
		updated_at: string
	}
	const secondSetup = await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	expect(secondSetup.slug).toBe('google')
	const after = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(preserveUserId) as typeof before
	expect(after).toEqual(before)
})

test('findOauthAppForProviderSetup covers family prefill, exact slug, and disagreement', async () => {
	const { env } = createEnv()
	const userId = 'user-family-prefill'

	expect(
		await findOauthAppForProviderSetup({
			env,
			userId: 'user-empty',
			name: 'linear',
		}),
	).toBeNull()

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	const googleFamily = await findOauthAppForProviderSetup({
		env,
		userId,
		name: 'google-calendar',
	})
	expect(googleFamily).toMatchObject({
		slug: 'google',
		provider: 'google',
		clientId: 'google-client-id-value',
		clientSecretSecretName: null,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce',
		extraAuthorizeParams: { access_type: 'offline' },
	})
	expect(googleFamily).not.toHaveProperty('accessTokenSecretName')
	expect(googleFamily).not.toHaveProperty('refreshTokenSecretName')

	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'calendar-only-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			},
		},
	})
	expect(
		await findOauthAppForProviderSetup({
			env,
			userId,
			name: 'google-calendar',
		}),
	).toMatchObject({
		slug: 'google-calendar',
		clientId: 'calendar-only-client',
		tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
	})

	const githubBase = {
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential' as const,
		clientId: 'shared-github-client-id',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
		},
	}
	const githubUserId = 'user-github-family'
	await upsertIntegration({
		env,
		userId: githubUserId,
		config: {
			...githubBase,
			name: 'github',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: null,
		},
	})
	await upsertIntegration({
		env,
		userId: githubUserId,
		config: {
			...githubBase,
			name: 'github-kent',
			clientSecretSecretName: 'github-kentClientSecret',
			accessTokenSecretName: 'githubKentAccessToken',
			refreshTokenSecretName: null,
		},
	})
	const githubFound = await findOauthAppForProviderSetup({
		env,
		userId: githubUserId,
		name: 'github-work',
	})
	expect(githubFound).toMatchObject({
		slug: 'github',
		provider: 'github',
		clientId: 'shared-github-client-id',
		clientSecretSecretName: null,
		flow: 'confidential',
	})

	const spotifyUserId = 'user-spotify-family'
	await upsertIntegration({
		env,
		userId: spotifyUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientId: 'spotify-personal-client',
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	await upsertIntegration({
		env,
		userId: spotifyUserId,
		config: {
			name: 'spotify-family',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientId: 'spotify-family-client',
			accessTokenSecretName: 'spotifyFamilyAccessToken',
			refreshTokenSecretName: 'spotifyFamilyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	const spotifyFound = await findOauthAppForProviderSetup({
		env,
		userId: spotifyUserId,
		name: 'spotify-kids',
	})
	expect(spotifyFound?.clientId).toBeNull()
	expect(spotifyFound).toMatchObject({
		tokenUrl: 'https://accounts.spotify.com/api/token',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		flow: 'pkce',
	})

	await upsertOauthAppWithoutConnection({
		env,
		userId: 'user-setup-exact',
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-from-setup',
			clientSecretSecretName: 'notionClientSecret',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	expect(
		await findOauthAppForProviderSetup({
			env,
			userId: 'user-setup-exact',
			name: 'notion',
		}),
	).toMatchObject({
		slug: 'notion',
		clientId: 'notion-client-from-setup',
		clientSecretSecretName: 'notionClientSecret',
	})
})

function createPlatformEnv() {
	const { env } = createEnv()
	return {
		env: {
			...env,
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>,
	}
}

async function provisionGithubPlatformApp(
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>,
) {
	return upsertPlatformOauthApp({
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
			allowedScopes: ['repo', 'read:user', 'gist'],
			defaultScopes: ['read:user'],
			requiredHosts: ['api.github.com'],
		},
	})
}

test('upsertPlatformIntegration connects a user to a platform app with no client secret exposure', async () => {
	const { env } = createPlatformEnv()
	await provisionGithubPlatformApp(env)

	const saved = await upsertPlatformIntegration({
		env,
		userId: 'user-platform',
		platformAppSlug: 'github',
		scopes: ['read:user', 'repo'],
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
	})
	expect(saved).toMatchObject({
		name: 'github',
		platform: true,
		clientId: 'platform-github-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(saved.requiredHosts).toEqual(['api.github.com', 'github.com'])
	expect(saved.authorization?.scopes).toEqual(['read:user', 'repo'])

	const listed = await listIntegrations({ env, userId: 'user-platform' })
	expect(listed).toHaveLength(1)
	expect(listed[0]?.platform).toBe(true)
	expect(JSON.stringify(listed)).not.toContain(
		'platform-github-client-secret-value',
	)

	const joined = await listJoinedIntegrations({
		env,
		userId: 'user-platform',
	})
	expect(joined[0]?.lane).toBe('platform')
	expect(joined[0]?.connection.platformAppSlug).toBe('github')
	expect(joined[0]?.connection.appSlug).toBeNull()
})

test('upsertPlatformIntegration rejects scopes outside the allowed menu', async () => {
	const { env } = createPlatformEnv()
	await provisionGithubPlatformApp(env)

	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-platform',
			platformAppSlug: 'github',
			scopes: ['admin:org'],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow('Scopes not allowed for platform integration "github"')
})

test('an empty allowed-scope menu is a strict allowlist: only scope-less connects pass', async () => {
	const { env } = createPlatformEnv()
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			allowedScopes: [],
			defaultScopes: [],
		},
	})

	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-strict',
			platformAppSlug: 'github',
			scopes: ['repo'],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow('Scopes not allowed for platform integration "github"')

	const saved = await upsertPlatformIntegration({
		env,
		userId: 'user-strict',
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(saved.authorization?.scopes).toEqual([])
})

test('upsertPlatformIntegration defaults empty scopes to the app default scopes', async () => {
	const { env } = createPlatformEnv()
	await provisionGithubPlatformApp(env)

	const saved = await upsertPlatformIntegration({
		env,
		userId: 'user-platform',
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(saved.authorization?.scopes).toEqual(['read:user'])
})

test('converting a sole-connection user app to the platform lane cleans up the orphan app', async () => {
	const { env } = createPlatformEnv()
	await provisionGithubPlatformApp(env)
	const userId = 'user-converts'

	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientId: 'personal-github-client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: null,
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})
	expect(await listOauthApps({ env, userId })).toHaveLength(1)

	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: 'github',
		scopes: ['read:user'],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(await listOauthApps({ env, userId })).toHaveLength(0)
	const joined = await listJoinedIntegrations({ env, userId })
	expect(joined).toHaveLength(1)
	expect(joined[0]?.lane).toBe('platform')
})

test('deleteIntegration removes a platform connection without touching the shared app', async () => {
	const { env } = createPlatformEnv()
	await provisionGithubPlatformApp(env)

	await upsertPlatformIntegration({
		env,
		userId: 'user-deletes',
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(
		await deleteIntegration({ env, userId: 'user-deletes', name: 'github' }),
	).toBe(true)
	expect(await listIntegrations({ env, userId: 'user-deletes' })).toEqual([])
	expect(await getAvailablePlatformApp({ env, slug: 'github' })).not.toBeNull()
})

test('disabled platform apps reject new connections and hide from availability', async () => {
	const { env } = createPlatformEnv()
	const app = await provisionGithubPlatformApp(env)
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: app.slug,
			clientId: app.clientId,
			tokenUrl: app.tokenUrl,
			authorizeUrl: app.authorizeUrl,
			flow: app.flow,
			enabled: false,
		},
	})

	expect(await listAvailablePlatformApps({ env })).toEqual([])
	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-blocked',
			platformAppSlug: 'github',
			scopes: [],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow('Platform integration "github" is not available.')
})
