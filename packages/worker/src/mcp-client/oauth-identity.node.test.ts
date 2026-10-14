import { expect, test } from 'vitest'
import {
	assertEndpointsOnIssuerOrigin,
	authorizationServerOriginFromDiscovery,
	discoveryMatchesAttemptAuthorizationServerOrigin,
	mcpOAuthAttemptIdentityInvalidMessage,
	mcpOAuthAttemptReconnectHref,
	oauthAttemptActorMatches,
	oauthAttemptIdentityMatches,
} from './oauth-identity.ts'

test('oauthAttemptIdentityMatches requires both pending ids and an exact match on each', () => {
	expect(
		oauthAttemptIdentityMatches({
			pendingServerId: 'mcp_1',
			pendingClientId: 'cid',
			serverId: 'mcp_1',
			clientId: 'cid',
		}),
	).toBe(true)
	expect(
		oauthAttemptIdentityMatches({
			pendingServerId: null,
			pendingClientId: 'cid',
			serverId: 'mcp_1',
			clientId: 'cid',
		}),
	).toBe(false)
	expect(
		oauthAttemptIdentityMatches({
			pendingServerId: 'mcp_1',
			pendingClientId: null,
			serverId: 'mcp_1',
			clientId: 'cid',
		}),
	).toBe(false)
	expect(
		oauthAttemptIdentityMatches({
			pendingServerId: 'mcp_1',
			pendingClientId: 'cid',
			serverId: 'mcp_2',
			clientId: 'cid',
		}),
	).toBe(false)
	expect(
		oauthAttemptIdentityMatches({
			pendingServerId: 'mcp_1',
			pendingClientId: 'cid',
			serverId: 'mcp_1',
			clientId: 'other',
		}),
	).toBe(false)
})

test('assertEndpointsOnIssuerOrigin refuses cross-origin authorization and token endpoints', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://evil.example/authorize',
				token_endpoint: 'https://auth.example/token',
			},
		}),
	).toThrow(/authorization_endpoint/)
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://evil.example/token',
			},
		}),
	).toThrow(/token_endpoint/)
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
			},
		}),
	).not.toThrow()
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
			},
		}),
	).toThrow(/missing a usable issuer/)
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {},
		}),
	).toThrow(/missing a usable issuer/)
})

test('oauthAttemptActorMatches requires both pending ids and an exact match', () => {
	expect(
		oauthAttemptActorMatches({
			pendingOwnerOrgId: 'org-1',
			pendingPersonId: 'person-1',
			ownerOrgId: 'org-1',
			personId: 'person-1',
		}),
	).toBe(true)
	expect(
		oauthAttemptActorMatches({
			pendingOwnerOrgId: 'org-1',
			pendingPersonId: 'person-1',
			ownerOrgId: 'org-2',
			personId: 'person-1',
		}),
	).toBe(false)
	expect(
		oauthAttemptActorMatches({
			pendingOwnerOrgId: 'org-1',
			pendingPersonId: 'person-1',
			ownerOrgId: 'org-1',
			personId: 'person-2',
		}),
	).toBe(false)
	expect(
		oauthAttemptActorMatches({
			pendingOwnerOrgId: null,
			pendingPersonId: 'person-1',
			ownerOrgId: 'org-1',
			personId: 'person-1',
		}),
	).toBe(false)
})

test('discovery AS origin helpers and reconnect copy stay fail-closed', () => {
	expect(
		authorizationServerOriginFromDiscovery({
			authorizationServerUrl: 'https://auth.example/oauth',
			authorizationServerMetadata: { issuer: 'https://auth.example' },
		}),
	).toBe('https://auth.example')
	expect(
		discoveryMatchesAttemptAuthorizationServerOrigin({
			pendingAuthorizationServerOrigin: 'https://auth.example',
			discovery: {
				authorizationServerMetadata: {
					issuer: 'https://auth.example',
					token_endpoint: 'https://evil.example/token',
				},
			},
		}),
	).toBe(false)
	expect(
		discoveryMatchesAttemptAuthorizationServerOrigin({
			pendingAuthorizationServerOrigin: 'https://auth.example',
			discovery: {
				authorizationServerMetadata: {
					issuer: 'https://other.example',
					token_endpoint: 'https://other.example/token',
				},
			},
		}),
	).toBe(false)
	expect(mcpOAuthAttemptReconnectHref()).toBe('/account/mcp-servers')
	expect(mcpOAuthAttemptIdentityInvalidMessage('docs')).toContain(
		`Reconnect at ${mcpOAuthAttemptReconnectHref()}`,
	)
	expect(mcpOAuthAttemptIdentityInvalidMessage('docs')).toContain('"docs"')
})
