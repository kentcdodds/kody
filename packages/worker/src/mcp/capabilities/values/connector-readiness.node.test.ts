import { expect, test } from 'vitest'
import {
	formatConnectorReadinessSummary,
	getConnectorReadiness,
} from './connector-readiness.ts'

const spotifyConnector = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.com/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce' as const,
	clientIdValueName: 'spotify-client-id',
	clientSecretSecretName: null,
	accessTokenSecretName: 'spotify-access-token',
	refreshTokenSecretName: 'spotify-refresh-token',
	requiredHosts: ['api.spotify.com'],
}

test('getConnectorReadiness reports ready when client id and refresh token metadata exist', () => {
	const readiness = getConnectorReadiness({
		connector: spotifyConnector,
		values: [{ name: 'spotify-client-id', value: 'client-id-123' }],
		userSecrets: [
			{ name: 'spotify-refresh-token' },
			{ name: 'spotify-access-token' },
		],
	})

	expect(readiness).toEqual({
		status: 'ready',
		authenticatedRequestsReady: true,
		available: {
			clientIdValue: true,
			accessTokenSecret: true,
			refreshTokenSecret: true,
			clientSecretSecret: null,
		},
		missingPrerequisites: [],
	})
	expect(formatConnectorReadinessSummary(readiness)).toBe(
		'Ready for authenticated requests via connector execute helpers.',
	)
})

test('getConnectorReadiness reports missing connector prerequisites without exposing secret values', () => {
	const readiness = getConnectorReadiness({
		connector: {
			...spotifyConnector,
			flow: 'confidential',
			clientSecretSecretName: 'spotify-client-secret',
		},
		values: [],
		userSecrets: [{ name: 'spotify-access-token' }],
	})

	expect(readiness.status).toBe('missing_prerequisites')
	expect(readiness.authenticatedRequestsReady).toBe(false)
	expect(readiness.available).toEqual({
		clientIdValue: false,
		accessTokenSecret: true,
		refreshTokenSecret: false,
		clientSecretSecret: false,
	})
	expect(readiness.missingPrerequisites).toEqual([
		{
			kind: 'value',
			requirement: 'client_id',
			name: 'spotify-client-id',
		},
		{
			kind: 'secret',
			requirement: 'refresh_token',
			name: 'spotify-refresh-token',
		},
		{
			kind: 'secret',
			requirement: 'client_secret',
			name: 'spotify-client-secret',
		},
	])
	expect(formatConnectorReadinessSummary(readiness)).toContain(
		'Missing prerequisites for authenticated requests:',
	)
})
