import { expect, test } from 'vitest'
import { filterIntegrations } from './integration-filter.ts'

test('integration filtering searches names, endpoints, scopes, hosts, and stored names', () => {
	const integrations = [
		{
			name: 'github',
			valueName: '_integration:github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			clientIdValueName: 'github-client-id',
			accessTokenSecretName: 'github-access-token',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo', 'read:user'],
			},
		},
		{
			name: 'spotify',
			valueName: '_integration:spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com',
			clientIdValueName: 'spotify-client-id',
			accessTokenSecretName: 'spotify-access-token',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-playback-state'],
			},
		},
	]

	expect(filterIntegrations(integrations, 'GITHUB repo')).toEqual([
		integrations[0],
	])
	expect(filterIntegrations(integrations, 'playback')).toEqual([
		integrations[1],
	])
	expect(filterIntegrations(integrations, 'missing')).toEqual([])
	expect(filterIntegrations(integrations, '')).toEqual(integrations)
})
