import { expect, test } from 'vitest'
import {
	buildIntegrationValueName,
	formatOAuthExchangeFailure,
	isOAuthExchangeSessionExpired,
	mergeConnectOauthConfig,
	parseConnectOauthNextSteps,
	parseSessionConnectOauthConfig,
	parseStoredIntegrationConfig,
	summarizeStoredSetupState,
} from './connect-oauth.tsx'

test('connect OAuth helpers parse stored integrations, merge reconnect configs, and derive provider defaults', () => {
	const parsed = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com/',
			flow: 'confidential',
			clientIdValueName: 'github-client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: 'githubRefreshToken',
			requiredHosts: ['api.github.com', ' github.com ', 'api.github.com'],
			authorization: {
				authorizeUrl: 'ftp://github.com/login/oauth/authorize',
				scopes: ['repo', 'read:user'],
				scopeSeparator: null,
				extraAuthorizeParams: { prompt: 'consent' },
			},
		}),
		null,
	)

	expect(parsed).toEqual({
		name: 'GitHub',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com/',
		flow: 'confidential',
		usePkce: null,
		clientIdValueName: 'github-client-id',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
		requiredHosts: ['api.github.com', 'github.com'],
		authorization: null,
	})
	// One canonical value key regardless of how the caller cases the provider.
	expect(buildIntegrationValueName('GitHub')).toBe('_integration:github')
	expect(buildIntegrationValueName('github')).toBe('_integration:github')
	expect(buildIntegrationValueName('Spotify Family')).toBe(
		'_integration:spotify-family',
	)

	const githubConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'github',
			providerKey: 'github',
			authorizeHost: 'github.com',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			tokenUrl: null,
			apiBaseUrl: null,
			scopes: ['repo', 'read:user'],
			flow: null,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ' ',
			extraAuthorizeParams: { prompt: 'consent' },
			providerSetupInstructions: 'Open the GitHub app settings.',
			dashboardUrl: 'https://github.com/settings/developers',
			allowedHosts: ['github.com'],
		},
		storedIntegration: {
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github-client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: 'githubRefreshToken',
			requiredHosts: ['api.github.com'],
		},
	})

	expect(githubConfig).toMatchObject({
		provider: 'GitHub',
		providerKey: 'github',
		authorizeHost: 'github.com',
		tokenHost: 'github.com',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		scopes: ['repo', 'read:user'],
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'form',
		scopeSeparator: ' ',
		extraAuthorizeParams: { prompt: 'consent' },
		dashboardUrl: 'https://github.com/settings/developers',
		clientIdValueName: 'github-client-id',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
		allowedHosts: ['api.github.com', 'github.com'],
	})

	const googleReconnectConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'google-youtube-brand',
			providerKey: 'google-youtube-brand',
			authorizeHost: null,
			authorizeUrl: null,
			tokenUrl: null,
			apiBaseUrl: null,
			scopes: null,
			flow: null,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: null,
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: [],
		},
		storedIntegration: {
			name: 'google-youtube-brand',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com/youtube/v3',
			flow: 'confidential',
			clientIdValueName: 'google-youtube-brand-client-id',
			clientSecretSecretName: 'googleYoutubeBrandClientSecret',
			accessTokenSecretName: 'googleYoutubeBrandAccessToken',
			refreshTokenSecretName: 'googleYoutubeBrandRefreshToken',
			requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [
					'https://www.googleapis.com/auth/youtube',
					'https://www.googleapis.com/auth/youtube.force-ssl',
				],
				scopeSeparator: null,
				extraAuthorizeParams: {
					access_type: 'offline',
					prompt: 'consent',
				},
			},
		},
	})

	expect(googleReconnectConfig).toMatchObject({
		provider: 'google-youtube-brand',
		authorizeHost: 'accounts.google.com',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		scopes: [
			'https://www.googleapis.com/auth/youtube',
			'https://www.googleapis.com/auth/youtube.force-ssl',
		],
		scopeSeparator: ' ',
		extraAuthorizeParams: {
			access_type: 'offline',
			prompt: 'consent',
		},
		allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
	})

	const googleFallbackConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'google-youtube-brand',
			providerKey: 'google-youtube-brand',
			authorizeHost: null,
			authorizeUrl: null,
			tokenUrl: null,
			apiBaseUrl: null,
			scopes: [],
			flow: null,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: [],
		},
		storedIntegration: {
			name: 'google-youtube-brand',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com/youtube/v3',
			flow: 'confidential',
			clientIdValueName: 'google-youtube-brand-client-id',
			clientSecretSecretName: 'googleYoutubeBrandClientSecret',
			accessTokenSecretName: 'googleYoutubeBrandAccessToken',
			refreshTokenSecretName: 'googleYoutubeBrandRefreshToken',
			requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
				scopeSeparator: null,
				extraAuthorizeParams: {
					access_type: 'offline',
					prompt: 'consent',
				},
			},
		},
	})

	expect(googleFallbackConfig).toMatchObject({
		scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
		extraAuthorizeParams: {
			access_type: 'offline',
			prompt: 'consent',
		},
	})

	const spotifyConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'spotify',
			providerKey: 'spotify',
			authorizeHost: 'accounts.spotify.com',
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			scopes: [],
			flow: 'pkce',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: ['accounts.spotify.com'],
		},
		storedIntegration: null,
	})

	expect(spotifyConfig).toMatchObject({
		provider: 'spotify',
		providerKey: 'spotify',
		tokenHost: 'accounts.spotify.com',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		flow: 'pkce',
		usePkce: true,
		tokenExchangeStyle: 'form',
		clientIdValueName: 'spotify-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
	})

	const confidentialSetup = summarizeStoredSetupState({
		flow: 'confidential',
		clientId: 'client-id',
		hasStoredClientSecret: false,
	})
	expect(confidentialSetup.isReady).toBe(false)
	expect(confidentialSetup.missingFields.length).toBeGreaterThan(0)

	const pkceSetup = summarizeStoredSetupState({
		flow: 'pkce',
		clientId: 'client-id',
		hasStoredClientSecret: false,
	})
	expect(pkceSetup.isReady).toBe(true)
	expect(pkceSetup.missingFields).toEqual([])
})

test('connect OAuth derives Notion basic-json exchange and surfaces provider failures instead of session expiry', () => {
	const notionConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'notion',
			providerKey: 'notion',
			authorizeHost: 'api.notion.com',
			authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			apiBaseUrl: 'https://api.notion.com/v1',
			scopes: [],
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ' ',
			extraAuthorizeParams: { owner: 'user', response_type: 'code' },
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: ['api.notion.com'],
		},
		storedIntegration: null,
	})

	expect(notionConfig).toMatchObject({
		provider: 'notion',
		tokenUrl: 'https://api.notion.com/v1/oauth/token',
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'basic-json',
		clientSecretSecretName: 'notionClientSecret',
		accessTokenSecretName: 'notionAccessToken',
	})

	const storedNotion = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			apiBaseUrl: 'https://api.notion.com/v1',
			flow: 'confidential',
			clientIdValueName: 'notion-client-id',
			clientSecretSecretName: 'notionClientSecret',
			accessTokenSecretName: 'notionAccessToken',
			refreshTokenSecretName: 'notionRefreshToken',
			requiredHosts: ['api.notion.com'],
			tokenExchangeStyle: 'basic-json',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: { owner: 'user' },
			},
		}),
		null,
	)
	expect(storedNotion?.tokenExchangeStyle).toBe('basic-json')

	expect(
		formatOAuthExchangeFailure({
			status: 401,
			data: { ok: false, error: 'Unauthorized.' },
		}),
	).toEqual({
		treatAsSessionExpired: true,
		error: 'Session expired.',
	})
	expect(
		isOAuthExchangeSessionExpired({
			status: 401,
			data: { ok: false, error: 'Unauthorized.' },
		}),
	).toBe(true)

	expect(
		formatOAuthExchangeFailure({
			status: 502,
			data: {
				ok: false,
				error: 'invalid_client',
				error_description: 'Client authentication failed',
				providerStatus: 401,
			},
		}),
	).toEqual({
		treatAsSessionExpired: false,
		error: 'Client authentication failed',
	})
	expect(
		isOAuthExchangeSessionExpired({
			status: 401,
			data: {
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			},
		}),
	).toBe(false)
})

test('connect OAuth derives Canva confidential + PKCE basic-form defaults and honors explicit overrides', () => {
	const canvaQueryConfig = {
		provider: 'canva',
		providerKey: 'canva',
		authorizeHost: 'www.canva.com',
		authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
		tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		apiBaseUrl: 'https://api.canva.com/rest/v1',
		scopes: ['design:content:read'],
		flow: null,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
		providerSetupInstructions: null,
		dashboardUrl: null,
		allowedHosts: ['api.canva.com'],
	}

	// Canva requires BOTH S256 PKCE and a client secret on token exchange, so
	// the host defaults must combine a confidential flow with PKCE enabled.
	const canvaConfig = mergeConnectOauthConfig({
		queryConfig: canvaQueryConfig,
		storedIntegration: null,
	})
	expect(canvaConfig).toMatchObject({
		provider: 'canva',
		tokenHost: 'api.canva.com',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
		clientSecretSecretName: 'canvaClientSecret',
		accessTokenSecretName: 'canvaAccessToken',
	})

	// Explicit query params still win over host defaults.
	const overriddenConfig = mergeConnectOauthConfig({
		queryConfig: {
			...canvaQueryConfig,
			usePkce: false,
			tokenExchangeStyle: 'form',
		},
		storedIntegration: null,
	})
	expect(overriddenConfig).toMatchObject({
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'form',
	})

	// PKCE can be enabled on top of a confidential flow for any provider.
	const confidentialPkceConfig = mergeConnectOauthConfig({
		queryConfig: {
			...canvaQueryConfig,
			provider: 'acme',
			providerKey: 'acme',
			authorizeHost: 'auth.acme.test',
			authorizeUrl: 'https://auth.acme.test/oauth/authorize',
			tokenUrl: 'https://auth.acme.test/oauth/token',
			apiBaseUrl: null,
			flow: 'confidential',
			usePkce: true,
			allowedHosts: ['auth.acme.test'],
		},
		storedIntegration: null,
	})
	expect(confidentialPkceConfig).toMatchObject({
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'form',
		clientSecretSecretName: 'acmeClientSecret',
	})

	// Reconnects read the persisted PKCE choice back from the stored config.
	const storedCanva = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'canva',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com/rest/v1',
			flow: 'confidential',
			usePkce: true,
			clientIdValueName: 'canva-client-id',
			clientSecretSecretName: 'canvaClientSecret',
			accessTokenSecretName: 'canvaAccessToken',
			refreshTokenSecretName: 'canvaRefreshToken',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
			authorization: {
				authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
				scopes: ['design:content:read'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		}),
		null,
	)
	expect(storedCanva?.usePkce).toBe(true)
	expect(storedCanva?.tokenExchangeStyle).toBe('basic-form')

	const reconnectConfig = mergeConnectOauthConfig({
		queryConfig: {
			...canvaQueryConfig,
			authorizeHost: null,
			authorizeUrl: null,
			tokenUrl: null,
			apiBaseUrl: null,
			scopes: null,
			allowedHosts: [],
		},
		storedIntegration: storedCanva,
	})
	expect(reconnectConfig).toMatchObject({
		provider: 'canva',
		authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
		tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
	})
})

test('session config parsing is strict: usePkce is required and stale shapes are rejected', () => {
	const sessionConfig = {
		provider: 'spotify',
		providerKey: 'spotify',
		authorizeHost: 'accounts.spotify.com',
		tokenHost: 'accounts.spotify.com',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: null,
		scopes: [],
		flow: 'pkce',
		usePkce: true,
		tokenExchangeStyle: 'form',
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
		providerSetupInstructions: null,
		dashboardUrl: null,
		clientIdValueName: 'spotify-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		allowedHosts: ['accounts.spotify.com'],
	}

	expect(
		parseSessionConnectOauthConfig(JSON.stringify(sessionConfig)),
	).toMatchObject({ provider: 'spotify', flow: 'pkce', usePkce: true })
	expect(
		parseSessionConnectOauthConfig(
			JSON.stringify({
				...sessionConfig,
				flow: 'confidential',
				usePkce: false,
			}),
		),
	).toMatchObject({ flow: 'confidential', usePkce: false })

	// No back-compat: a snapshot without usePkce (persisted by pre-change code)
	// is rejected and the user restarts the flow.
	const { usePkce: _omitted, ...withoutUsePkce } = sessionConfig
	expect(
		parseSessionConnectOauthConfig(JSON.stringify(withoutUsePkce)),
	).toBeNull()

	expect(parseSessionConnectOauthConfig('not json')).toBeNull()
	expect(
		parseSessionConnectOauthConfig(JSON.stringify({ provider: 'x' })),
	).toBeNull()
	expect(
		parseSessionConnectOauthConfig(
			JSON.stringify({ ...sessionConfig, flow: 'implicit' }),
		),
	).toBeNull()
})

test('parseConnectOauthNextSteps accepts suggestion payload and drops unsafe URLs', () => {
	const parsed = parseConnectOauthNextSteps({
		guidance: 'Connected. Auth credentials only.',
		integrationName: 'google',
		suggestions: [
			{
				listingId: 'listing-1',
				name: 'google-helpers',
				kodyId: '@owner/google-helpers',
				description: 'Trusted google helpers',
				trusted: true,
				publicUrl: 'https://example.com/community/listing-1',
				forkPrompt: 'Fork google-helpers',
			},
			{
				listingId: 'bad',
				name: 'bad',
				kodyId: '@owner/bad',
				description: 'bad',
				trusted: false,
				publicUrl: 'javascript:alert(1)',
				forkPrompt: 'bad',
			},
		],
		createHelpersCta: {
			label: 'Create helpers package',
			prompt: 'Create a thin helpers package for google',
		},
	})
	expect(parsed).toEqual({
		guidance: 'Connected. Auth credentials only.',
		integrationName: 'google',
		suggestions: [
			{
				listingId: 'listing-1',
				name: 'google-helpers',
				kodyId: '@owner/google-helpers',
				description: 'Trusted google helpers',
				trusted: true,
				publicUrl: 'https://example.com/community/listing-1',
				forkPrompt: 'Fork google-helpers',
			},
		],
		createHelpersCta: {
			label: 'Create helpers package',
			prompt: 'Create a thin helpers package for google',
		},
	})
	expect(parseConnectOauthNextSteps(null)).toBeNull()
	expect(parseConnectOauthNextSteps({ guidance: 'x' })).toBeNull()
})
