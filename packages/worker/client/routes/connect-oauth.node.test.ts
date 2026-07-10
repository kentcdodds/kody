import { expect, test } from 'vitest'
import {
	buildIntegrationValueName,
	formatOAuthExchangeFailure,
	getIntegrationValueCandidates,
	isOAuthExchangeSessionExpired,
	mergeConnectOauthConfig,
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
		clientIdValueName: 'github-client-id',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
		requiredHosts: ['api.github.com', 'github.com'],
		authorization: null,
	})
	expect(getIntegrationValueCandidates('GitHub', 'github')).toEqual([
		buildIntegrationValueName('GitHub'),
		buildIntegrationValueName('github'),
	])
	expect(getIntegrationValueCandidates('github', 'github')).toEqual([
		buildIntegrationValueName('github'),
	])

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
