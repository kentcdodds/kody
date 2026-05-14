import { expect, test } from 'vitest'
import {
	buildIntegrationValueName,
	getIntegrationValueCandidates,
	mergeConnectOauthConfig,
	parseStoredIntegrationConfig,
	summarizeStoredSetupState,
} from './connect-oauth.tsx'

test('parseStoredIntegrationConfig returns normalized integration config', () => {
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
				authorizeUrl: 'https://github.com/login/oauth/authorize',
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
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo', 'read:user'],
			scopeSeparator: null,
			extraAuthorizeParams: { prompt: 'consent' },
		},
	})
})

test('parseStoredIntegrationConfig rejects non-http authorization URLs', () => {
	const parsed = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientIdValueName: 'github-client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: 'githubRefreshToken',
			requiredHosts: ['github.com'],
			authorization: {
				authorizeUrl: 'ftp://github.com/login/oauth/authorize',
				scopes: ['repo'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		}),
		null,
	)

	expect(parsed?.authorization).toBeNull()
})

test('getIntegrationValueCandidates prefers provider and normalized key without duplicates', () => {
	expect(getIntegrationValueCandidates('GitHub', 'github')).toEqual([
		buildIntegrationValueName('GitHub'),
		buildIntegrationValueName('github'),
	])

	expect(getIntegrationValueCandidates('github', 'github')).toEqual([
		buildIntegrationValueName('github'),
	])
})

test('mergeConnectOauthConfig prefers stored integration metadata for saved providers', () => {
	const config = mergeConnectOauthConfig({
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

	expect(config).toEqual({
		provider: 'GitHub',
		providerKey: 'github',
		authorizeHost: 'github.com',
		tokenHost: 'github.com',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		scopes: ['repo', 'read:user'],
		flow: 'confidential',
		scopeSeparator: ' ',
		extraAuthorizeParams: { prompt: 'consent' },
		providerSetupInstructions: 'Open the GitHub app settings.',
		dashboardUrl: 'https://github.com/settings/developers',
		clientIdValueName: 'github-client-id',
		clientSecretSecretName: 'githubClientSecret',
		accessTokenSecretName: 'githubAccessToken',
		refreshTokenSecretName: 'githubRefreshToken',
		allowedHosts: ['api.github.com', 'github.com'],
	})
})

test('mergeConnectOauthConfig can derive reconnect authorization from stored integration metadata', () => {
	const config = mergeConnectOauthConfig({
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

	expect(config).toMatchObject({
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
})

test('mergeConnectOauthConfig falls back to stored authorization when query values are empty defaults', () => {
	const config = mergeConnectOauthConfig({
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

	expect(config).toMatchObject({
		scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
		extraAuthorizeParams: {
			access_type: 'offline',
			prompt: 'consent',
		},
	})
})

test('mergeConnectOauthConfig falls back to derived names when no integration exists', () => {
	const config = mergeConnectOauthConfig({
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

	expect(config).toMatchObject({
		provider: 'spotify',
		providerKey: 'spotify',
		tokenHost: 'accounts.spotify.com',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		flow: 'pkce',
		clientIdValueName: 'spotify-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
	})
})

test('summarizeStoredSetupState marks confidential flow incomplete when secret is missing', () => {
	expect(
		summarizeStoredSetupState({
			flow: 'confidential',
			clientId: 'client-id',
			hasStoredClientSecret: false,
		}),
	).toEqual({
		missingFields: ['client secret'],
		isReady: false,
	})

	expect(
		summarizeStoredSetupState({
			flow: 'pkce',
			clientId: 'client-id',
			hasStoredClientSecret: false,
		}),
	).toEqual({
		missingFields: [],
		isReady: true,
	})
})
