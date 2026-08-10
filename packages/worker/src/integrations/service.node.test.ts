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

test('upsertIntegration reuses matching app tuples, splits on endpoint mismatch, and normalizes required hosts', async () => {
	const { env } = createEnv()
	const reuseUserId = 'user-upsert'

	const normalized = await upsertIntegration({
		env,
		userId: reuseUserId,
		config: {
			...baseGoogleConfig,
			requiredHosts: [
				'https://www.googleapis.com',
				'HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2',
				'oauth2.googleapis.com',
			],
		},
	})
	expect(normalized.requiredHosts).toEqual([
		'accounts.google.com',
		'oauth2.googleapis.com',
		'www.googleapis.com',
	])

	await upsertIntegration({
		env,
		userId: reuseUserId,
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

	const apps = await listOauthApps({ env, userId: reuseUserId })
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
	})

	const listed = await listIntegrations({ env, userId: reuseUserId })
	expect(listed.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])
	expect(
		listed.every((entry) => entry.clientId === 'google-client-id-value'),
	).toBe(true)

	const splitUserId = 'user-upsert-split'
	await upsertIntegration({
		env,
		userId: splitUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: splitUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-legacy',
			tokenUrl: 'https://oauth2.googleapis.com/token/legacy',
			accessTokenSecretName: 'googleLegacyAccessToken',
			refreshTokenSecretName: 'googleLegacyRefreshToken',
		},
	})

	const splitApps = await listOauthApps({ env, userId: splitUserId })
	expect(splitApps).toHaveLength(2)
	expect(splitApps.map((app) => app.slug).sort()).toEqual([
		'google',
		'google-legacy',
	])
	expect(splitApps.find((app) => app.slug === 'google')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token',
	)
	expect(splitApps.find((app) => app.slug === 'google-legacy')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token/legacy',
	)

	const google = await getIntegration({
		env,
		userId: splitUserId,
		name: 'google',
	})
	const legacy = await getIntegration({
		env,
		userId: splitUserId,
		name: 'google-legacy',
	})
	expect(google?.tokenUrl).toBe('https://oauth2.googleapis.com/token')
	expect(legacy?.tokenUrl).toBe('https://oauth2.googleapis.com/token/legacy')
})

test('rotateOauthAppClientCredentials updates sibling joins, blocks delete while connected, and canonicalizes slugs', async () => {
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

	const google = await getIntegration({ env, userId, name: 'google' })
	const googleMail = await getIntegration({ env, userId, name: 'google-mail' })
	expect(google?.clientId).toBe('google-client-id-rotated')
	expect(google?.clientSecretSecretName).toBe('googleClientSecretRotated')
	expect(googleMail?.clientId).toBe('google-client-id-rotated')
	expect(googleMail?.clientSecretSecretName).toBe('googleClientSecretRotated')

	await expect(
		deleteOauthAppIfUnused({ env, userId, slug: 'GOOGLE' }),
	).rejects.toThrow(/still has 2 connections/)

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

test('shared app identity survives reuse and scope-only resaves across sibling connections', async () => {
	const { env, sqlite } = createEnv()

	const preserveUserId = 'user-provider-preserve'
	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: preserveUserId,
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
		.get(preserveUserId) as {
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
		userId: preserveUserId,
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
	const afterReuse = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		)
		.get(preserveUserId) as typeof before
	expect(afterReuse).toEqual(before)

	const resaveUserId = 'user-four-shared'
	const names = [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const
	for (const name of names) {
		await upsertIntegration({
			env,
			userId: resaveUserId,
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
	const beforeResave = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		)
		.get(resaveUserId)

	await upsertIntegration({
		env,
		userId: resaveUserId,
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
	const afterResave = sqlite
		.prepare(
			`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		)
		.get(resaveUserId)
	expect(afterResave).toEqual(beforeResave)

	const connections = sqlite
		.prepare(
			`SELECT name, app_slug, scopes_json, required_hosts_json
			FROM user_integrations WHERE user_id = ? ORDER BY name`,
		)
		.all(resaveUserId) as Array<{
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

test('rematch deletes orphan apps, keeps sibling apps intact, and converts sole user apps to platform', async () => {
	const { env, sqlite } = createEnv()
	const orphanUserId = 'user-orphan'

	await upsertIntegration({
		env,
		userId: orphanUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: orphanUserId,
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
			.all(orphanUserId),
	).toEqual([{ slug: 'google' }, { slug: 'solo-app' }])

	await upsertIntegration({
		env,
		userId: orphanUserId,
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
			.all(orphanUserId),
	).toEqual([{ slug: 'google' }])
	expect(
		sqlite
			.prepare(
				`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? ORDER BY name`,
			)
			.all(orphanUserId),
	).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'solo-app', app_slug: 'google' },
	])

	const siblingUserId = 'user-sibling-keep'
	for (const name of [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const) {
		await upsertIntegration({
			env,
			userId: siblingUserId,
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
				.get(siblingUserId) as { count: number }
		).count,
	).toBe(4)

	await upsertIntegration({
		env,
		userId: siblingUserId,
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
		.get(siblingUserId) as { slug: string; provider: string }
	expect(googleApp).toEqual({ slug: 'google', provider: 'google' })
	expect(
		(
			sqlite
				.prepare(
					`SELECT count(*) AS count FROM user_integrations
					WHERE user_id = ? AND app_slug = 'google'`,
				)
				.get(siblingUserId) as { count: number }
		).count,
	).toBe(3)
	expect(
		sqlite
			.prepare(
				`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? AND name = 'google-drive'`,
			)
			.get(siblingUserId),
	).toEqual({ name: 'google-drive', app_slug: 'google-drive' })

	const platformEnv = createPlatformEnv()
	await provisionGithubPlatformApp(platformEnv.env)
	const convertUserId = 'user-converts'

	await upsertIntegration({
		env: platformEnv.env,
		userId: convertUserId,
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
	expect(
		await listOauthApps({ env: platformEnv.env, userId: convertUserId }),
	).toHaveLength(1)

	await upsertPlatformIntegration({
		env: platformEnv.env,
		userId: convertUserId,
		platformAppSlug: 'github',
		scopes: ['read:user'],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(
		await listOauthApps({ env: platformEnv.env, userId: convertUserId }),
	).toHaveLength(0)
	const joined = await listJoinedIntegrations({
		env: platformEnv.env,
		userId: convertUserId,
	})
	expect(joined).toHaveLength(1)
	expect(joined[0]?.lane).toBe('platform')
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

test('findOauthAppForProviderSetup prefers an exact-slug setup app over family prefill', async () => {
	const { env } = createEnv()
	const userId = 'user-family-prefill'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
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
})

function createPlatformEnv() {
	const base = createEnv()
	return {
		...base,
		env: {
			...base.env,
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

test('upsertPlatformIntegration enforces connect policy, hides secrets, and deletes without orphaning the shared app', async () => {
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

	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-platform-scopes',
			platformAppSlug: 'github',
			scopes: ['admin:org'],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow('Scopes not allowed for platform integration "github"')

	const defaultScopes = await upsertPlatformIntegration({
		env,
		userId: 'user-platform-defaults',
		platformAppSlug: 'github',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(defaultScopes.authorization?.scopes).toEqual(['read:user'])

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github-strict',
			clientId: 'platform-github-strict-id',
			clientSecret: 'platform-github-strict-secret',
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
			platformAppSlug: 'github-strict',
			scopes: ['repo'],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow(
		'Scopes not allowed for platform integration "github-strict"',
	)
	const scopeless = await upsertPlatformIntegration({
		env,
		userId: 'user-strict',
		platformAppSlug: 'github-strict',
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	expect(scopeless.authorization?.scopes).toEqual([])

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

	const disabledEnv = createPlatformEnv()
	const disabledApp = await provisionGithubPlatformApp(disabledEnv.env)
	await upsertPlatformOauthApp({
		db: disabledEnv.env.APP_DB,
		env: disabledEnv.env,
		app: {
			slug: disabledApp.slug,
			clientId: disabledApp.clientId,
			tokenUrl: disabledApp.tokenUrl,
			authorizeUrl: disabledApp.authorizeUrl,
			flow: disabledApp.flow,
			enabled: false,
		},
	})

	expect(await listAvailablePlatformApps({ env: disabledEnv.env })).toEqual([])
	await expect(
		upsertPlatformIntegration({
			env: disabledEnv.env,
			userId: 'user-blocked',
			platformAppSlug: 'github',
			scopes: [],
			accessTokenSecretName: 'githubAccessToken',
		}),
	).rejects.toThrow('Platform integration "github" is not available.')
})

test('loading a platform integration adds current app hosts without removing connection hosts', async () => {
	const { env, sqlite } = createPlatformEnv()
	const app = await provisionGithubPlatformApp(env)
	await upsertPlatformIntegration({
		env,
		userId: 'user-stale-platform-hosts',
		platformAppSlug: app.slug,
		scopes: [],
		accessTokenSecretName: 'githubAccessToken',
	})
	sqlite
		.prepare(
			`UPDATE user_integrations
			SET required_hosts_json = ?
			WHERE user_id = ? AND name = ?`,
		)
		.run(
			JSON.stringify(['api.github.com', 'user-added.example.com']),
			'user-stale-platform-hosts',
			'github',
		)
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: app.slug,
			clientId: app.clientId,
			tokenUrl: app.tokenUrl,
			authorizeUrl: app.authorizeUrl,
			apiBaseUrl: app.apiBaseUrl,
			flow: app.flow,
			requiredHosts: ['api.github.com', 'uploads.github.com'],
		},
	})

	const loaded = await getIntegration({
		env,
		userId: 'user-stale-platform-hosts',
		name: 'github',
	})

	expect(loaded?.requiredHosts).toEqual([
		'api.github.com',
		'uploads.github.com',
		'user-added.example.com',
	])
	expect(
		JSON.parse(
			(
				sqlite
					.prepare(
						`SELECT required_hosts_json
						FROM user_integrations
						WHERE user_id = ? AND name = ?`,
					)
					.get('user-stale-platform-hosts', 'github') as {
					required_hosts_json: string
				}
			).required_hosts_json,
		),
	).toEqual(['api.github.com', 'uploads.github.com', 'user-added.example.com'])
})
