import { utf8ToBase64Url } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import {
	createCodeChallenge,
	createCodeVerifier,
	decodeBase64Payload,
	formatOAuthExchangeFailure,
	isMostlyPrintable,
	isOAuthExchangeSessionExpired,
	isSafeExternalUrl,
	mergeConnectOauthConfig,
	parseConnectOauthNextSteps,
	parseExtraParams,
	parseOptionalUrl,
	parseProviderSetupInstructions,
	parseScopes,
	parseSessionConnectOauthConfig,
	parseStoredIntegrationConfig,
	summarizeStoredSetupState,
} from './connect-oauth-config.ts'

test('connect OAuth helpers parse stored integrations, merge reconnect configs, and derive provider defaults', () => {
	const parsed = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com/',
			flow: 'confidential',
			clientId: 'github-client-id-value',
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
		clientId: 'github-client-id-value',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
		requiredHosts: ['api.github.com', 'github.com'],
		authorization: null,
	})

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
			clientId: 'github-client-id-value',
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
		clientId: 'github-client-id-value',
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
			clientId: 'google-youtube-brand-client-id-value',
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
			clientId: 'google-youtube-brand-client-id-value',
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
		clientId: '',
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
			clientId: 'notion-client-id-value',
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
			clientId: 'canva-client-id-value',
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
		clientId: 'canva-client-id-value',
	})
})

test('shared-app family lookup prefills google-calendar from the google app payload', () => {
	// integrations.json?name=google-calendar resolves the shared `google` app
	// (slug ≠ name) and returns this shape; the client must still merge the
	// client id for a fresh multi-account setup session.
	const storedFromFamilyLookup = parseStoredIntegrationConfig(
		{
			name: 'google-calendar',
			appSlug: 'google',
			provider: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			clientSecretSecretName: null,
			accessTokenSecretName: 'google-calendarAccessToken',
			refreshTokenSecretName: 'google-calendarRefreshToken',
			requiredHosts: [],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
		null,
	)
	expect(storedFromFamilyLookup?.clientId).toBe('shared-google-client')

	const config = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'google-calendar',
			providerKey: 'google-calendar',
			authorizeHost: 'accounts.google.com',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			scopes: ['calendar.readonly'],
			flow: 'pkce',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: ['www.googleapis.com'],
		},
		storedIntegration: storedFromFamilyLookup,
	})
	expect(config).toMatchObject({
		provider: 'google-calendar',
		clientId: 'shared-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		accessTokenSecretName: 'google-calendarAccessToken',
	})
})

test('abandoned setup still prefills client id from a connectionless app on a fresh session', () => {
	// This is the regression: after setup we persist the app (not only session
	// storage). A later visit with no session snapshot must still see the
	// client id via the integrations.json?name= lookup payload.
	const storedFromAppOnlyLookup = parseStoredIntegrationConfig(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientId: 'spotify-client-from-setup',
			clientSecretSecretName: null,
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: [],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
		null,
	)
	expect(storedFromAppOnlyLookup?.clientId).toBe('spotify-client-from-setup')

	const withPersistedApp = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'spotify',
			providerKey: 'spotify',
			authorizeHost: 'accounts.spotify.com',
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			scopes: ['user-read-playback-state'],
			flow: 'pkce',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: ['accounts.spotify.com'],
		},
		storedIntegration: storedFromAppOnlyLookup,
	})
	expect(withPersistedApp?.clientId).toBe('spotify-client-from-setup')
	expect(
		summarizeStoredSetupState({
			flow: 'pkce',
			clientId: withPersistedApp?.clientId ?? '',
			hasStoredClientSecret: false,
		}).isReady,
	).toBe(true)

	// Without the setup-time app persist, a fresh session has no stored
	// integration and the client id field is empty — the bug this test guards.
	const withoutPersistedApp = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'spotify',
			providerKey: 'spotify',
			authorizeHost: 'accounts.spotify.com',
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			scopes: ['user-read-playback-state'],
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
	expect(withoutPersistedApp?.clientId).toBe('')
	expect(
		summarizeStoredSetupState({
			flow: 'pkce',
			clientId: withoutPersistedApp?.clientId ?? '',
			hasStoredClientSecret: false,
		}).isReady,
	).toBe(false)
})

test('connect OAuth keeps slack comma scope separators and extra authorize params', () => {
	const slackConfig = mergeConnectOauthConfig({
		queryConfig: {
			provider: 'slack',
			providerKey: 'slack',
			authorizeHost: 'slack.com',
			authorizeUrl: 'https://slack.com/oauth/v2/authorize',
			tokenUrl: 'https://slack.com/api/oauth.v2.access',
			apiBaseUrl: 'https://slack.com/api',
			scopes: ['channels:read', 'chat:write'],
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: ',',
			extraAuthorizeParams: { user_scope: 'identify' },
			providerSetupInstructions: null,
			dashboardUrl: null,
			allowedHosts: ['slack.com'],
		},
		storedIntegration: null,
	})
	expect(slackConfig).toMatchObject({
		scopeSeparator: ',',
		extraAuthorizeParams: { user_scope: 'identify' },
		usePkce: false,
		clientSecretSecretName: 'slackClientSecret',
	})
})

test('session config parsing is strict: usePkce and clientId are required and stale shapes are rejected', () => {
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
		clientId: 'spotify-client-id-value',
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

	// Legacy clientIdValueName snapshots are also rejected.
	expect(
		parseSessionConnectOauthConfig(
			JSON.stringify({
				...sessionConfig,
				clientId: undefined,
				clientIdValueName: 'spotify-client-id',
			}),
		),
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
	expect(
		parseConnectOauthNextSteps({
			guidance: 'g',
			integrationName: 'x',
			suggestions: 'not-an-array',
			createHelpersCta: { label: 'a', prompt: 'b' },
		}),
	).toBeNull()
	expect(
		parseConnectOauthNextSteps({
			guidance: 'g',
			integrationName: 'x',
			suggestions: [{ listingId: 1 }],
			createHelpersCta: { label: 'a', prompt: 'b' },
		}),
	).toEqual({
		guidance: 'g',
		integrationName: 'x',
		suggestions: [],
		createHelpersCta: { label: 'a', prompt: 'b' },
	})
	expect(
		parseConnectOauthNextSteps({
			guidance: 'g',
			integrationName: 'x',
			suggestions: [],
			createHelpersCta: { label: 1, prompt: 'b' },
		}),
	).toBeNull()
})

test('connect OAuth query helpers decode instructions, scopes, and safe URLs', () => {
	expect(isSafeExternalUrl('https://example.com/path')).toBe(true)
	expect(isSafeExternalUrl('http://localhost:8787')).toBe(true)
	expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
	expect(isSafeExternalUrl('ftp://files.example.com')).toBe(false)
	expect(parseOptionalUrl(null)).toBeNull()
	expect(parseOptionalUrl('https://example.com/a?b=1')).toBe(
		'https://example.com/a?b=1',
	)
	expect(parseOptionalUrl('not a url')).toBeNull()

	expect(decodeBase64Payload('!!!')).toBeNull()
	expect(
		decodeBase64Payload(utf8ToBase64Url('Open the developer console.')),
	).toBe('Open the developer console.')
	expect(isMostlyPrintable('printable text\nwith tabs\tand returns\r')).toBe(
		true,
	)
	expect(isMostlyPrintable('\u0001\u0002\u0003\u0004\u0005')).toBe(false)

	expect(parseExtraParams(null)).toEqual({})
	expect(
		parseExtraParams('{"prompt":"consent","access_type":"offline"}'),
	).toEqual({
		prompt: 'consent',
		access_type: 'offline',
	})
	expect(parseExtraParams('{"n":1,"b":true,"x":null}')).toEqual({
		n: '1',
		b: 'true',
		x: 'null',
	})
	expect(parseExtraParams('{')).toEqual({})
	expect(parseScopes('repo, read:user  openid')).toEqual([
		'repo',
		'read:user',
		'openid',
	])
	expect(parseScopes('["repo","read:user"]')).toEqual(['repo', 'read:user'])
	expect(parseScopes('[not-json')).toEqual(['[not-json'])

	const plain = 'Visit the provider console and create an OAuth app.'
	const encoded = utf8ToBase64Url(plain)
	expect(parseProviderSetupInstructions(null)).toBeNull()
	expect(parseProviderSetupInstructions(plain)).toBe(plain)
	expect(parseProviderSetupInstructions(`base64:${encoded}`)).toBe(plain)
	expect(parseProviderSetupInstructions(encoded)).toBe(plain)
	expect(parseProviderSetupInstructions('base64:!!!')).toBe('base64:!!!')
})

test('PKCE helpers match RFC 7636 S256 vector and current verifier shape', async () => {
	const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
	await expect(createCodeChallenge(rfcVerifier)).resolves.toBe(
		'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
	)

	const verifier = createCodeVerifier()
	// Current implementation samples 64 random bytes → 86-char base64url (not the
	// 43-char / 32-byte length recommended by RFC 7636 appendix B).
	expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
	expect(verifier).toHaveLength(86)
	await expect(createCodeChallenge(verifier)).resolves.toMatch(
		/^[A-Za-z0-9_-]+$/,
	)
})
