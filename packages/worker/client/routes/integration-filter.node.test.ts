import { expect, test } from 'vitest'
import {
	filterIntegrations,
	groupIntegrationsByApp,
	integrationDisplayName,
	oauthAppDisplayName,
} from './integration-filter.ts'

test('integration filtering searches names, endpoints, scopes, hosts, and app metadata', () => {
	const integrations = [
		{
			name: 'github',
			appSlug: 'github',
			provider: 'github',
			appLabel: null,
			accountLabel: null,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			clientId: 'github-client-id-value',
			accessTokenSecretName: 'github-access-token',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo', 'read:user'],
			},
		},
		{
			name: 'spotify',
			appSlug: 'spotify',
			provider: 'spotify',
			appLabel: null,
			accountLabel: null,
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com',
			clientId: 'spotify-client-id-value',
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

test('groupIntegrationsByApp groups sibling connections under one OAuth app', () => {
	const integrations = [
		{
			name: 'google',
			appSlug: 'google',
			provider: 'google',
			appLabel: null,
			accountLabel: 'Personal',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			clientId: 'shared-google-client',
			accessTokenSecretName: 'googleAccessToken',
		},
		{
			name: 'google-calendar',
			appSlug: 'google',
			provider: 'google',
			appLabel: null,
			accountLabel: 'Work calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			clientId: 'shared-google-client',
			accessTokenSecretName: 'googleCalendarAccessToken',
		},
		{
			name: 'github',
			appSlug: 'github',
			provider: 'github',
			appLabel: null,
			accountLabel: null,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			clientId: 'github-client',
			accessTokenSecretName: 'githubAccessToken',
		},
	]

	const groups = groupIntegrationsByApp(integrations)
	expect(groups).toHaveLength(2)
	expect(groups[0]).toMatchObject({
		appSlug: 'google',
		clientId: 'shared-google-client',
		connections: [
			expect.objectContaining({ name: 'google' }),
			expect.objectContaining({ name: 'google-calendar' }),
		],
	})
	expect(groups[1]?.connections).toHaveLength(1)
	expect(oauthAppDisplayName(groups[0]!)).toBe('google')
	expect(integrationDisplayName(integrations[0]!)).toBe('Personal')
	expect(integrationDisplayName(integrations[2]!)).toBe('github')
})
