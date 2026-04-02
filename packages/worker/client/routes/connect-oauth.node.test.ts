import { expect, test } from 'vitest'
import {
	buildConnectorValueName,
	getConnectorValueCandidates,
	mergeConnectOauthConfig,
	parseStoredConnectorConfig,
	summarizeStoredSetupState,
} from './connect-oauth.tsx'

test('parseStoredConnectorConfig returns normalized connector config', () => {
	const parsed = parseStoredConnectorConfig(
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
	})
})

test('getConnectorValueCandidates prefers provider and normalized key without duplicates', () => {
	expect(getConnectorValueCandidates('GitHub', 'github')).toEqual([
		buildConnectorValueName('GitHub'),
		buildConnectorValueName('github'),
	])

	expect(getConnectorValueCandidates('github', 'github')).toEqual([
		buildConnectorValueName('github'),
	])
})

test('mergeConnectOauthConfig prefers stored connector metadata for saved providers', () => {
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
		storedConnector: {
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

test('mergeConnectOauthConfig falls back to derived names when no connector exists', () => {
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
		storedConnector: null,
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
