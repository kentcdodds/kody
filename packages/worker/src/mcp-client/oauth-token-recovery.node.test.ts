import { expect, test } from 'vitest'
import {
	buildMcpOAuthMissingRefreshGrantLastError,
	buildMcpOAuthTokenRecoveryLastError,
	clientIdFromMcpOAuthTokenStorageKey,
	describeMcpOAuthTokenRecovery,
	isMcpOAuthGrantIssueLastError,
	isMcpOAuthTokenRecoveryLastError,
	mcpOAuthDiscoveryAdvertisesRefresh,
	mcpOAuthTokenRecoveryStorageKey,
	mergeMcpOAuthTokens,
	readMcpOAuthTokenPresence,
	restoreReadableMcpOAuthTokens,
	shouldAttemptMcpOAuthRefresh,
	shouldQueueMcpTokenRecoveryDisconnected,
	withPreservedMcpOAuthRefreshToken,
} from './oauth-token-recovery.ts'

test('token recovery inspects stored OAuth blobs without treating empty strings as tokens', () => {
	const none = { hasAccessToken: false, hasRefreshToken: false }
	const accessOnly = { hasAccessToken: true, hasRefreshToken: false }
	const both = { hasAccessToken: true, hasRefreshToken: true }
	expect(readMcpOAuthTokenPresence(null)).toEqual(none)
	expect(
		readMcpOAuthTokenPresence({ access_token: '  ', refresh_token: '' }),
	).toEqual(none)
	expect(
		readMcpOAuthTokenPresence({ access_token: 'at', refresh_token: 'rt' }),
	).toEqual(both)
	expect(shouldAttemptMcpOAuthRefresh(accessOnly)).toBe(true)
	expect(shouldAttemptMcpOAuthRefresh(none)).toBe(false)

	const queueCases = [
		{ presence: accessOnly, hasTokenRecoveryLastError: false, expected: true },
		{ presence: both, hasTokenRecoveryLastError: false, expected: false },
		{ presence: none, hasTokenRecoveryLastError: true, expected: true },
		{ presence: none, hasTokenRecoveryLastError: false, expected: false },
	]
	expect(
		queueCases.filter(
			({ expected, ...input }) =>
				shouldQueueMcpTokenRecoveryDisconnected({
					wasReady: false,
					...input,
				}) !== expected,
		),
	).toEqual([])
	expect(mcpOAuthTokenRecoveryStorageKey('server-1')).toBe(
		'mcp-oauth-token-recovery/server-1',
	)
	expect(
		clientIdFromMcpOAuthTokenStorageKey({
			clientName: 'Kody',
			serverId: 'home',
			key: '/Kody/home/https://kody.codes/oauth/client-metadata.json/token',
		}),
	).toBe('https://kody.codes/oauth/client-metadata.json')

	const authorizationServerUrl = 'https://auth.example'
	const refreshAdvertisedCases = [
		{
			discovery: {
				grant_types_supported: ['authorization_code', 'refresh_token'],
				scopes_supported: ['mcp'],
			},
			expected: true,
		},
		{ discovery: { scopes_supported: ['offline_access'] }, expected: true },
		{
			discovery: {
				grant_types_supported: ['authorization_code'],
				scopes_supported: ['mcp'],
			},
			expected: false,
		},
		{
			discovery: {
				authorizationServerUrl,
				authorizationServerMetadata: {
					grant_types_supported: ['authorization_code', 'refresh_token'],
				},
			},
			expected: true,
		},
		{
			discovery: {
				authorizationServerUrl,
				resourceMetadata: { scopes_supported: ['offline_access'] },
			},
			expected: true,
		},
	]
	expect(
		refreshAdvertisedCases.filter(
			({ discovery, expected }) =>
				mcpOAuthDiscoveryAdvertisesRefresh(discovery) !== expected,
		),
	).toEqual([])
	expect(
		withPreservedMcpOAuthRefreshToken({
			incoming: { access_token: 'new-at' },
			sources: [{ refresh_token: 'sidecar-rt' }],
		}),
	).toEqual({ access_token: 'new-at', refresh_token: 'sidecar-rt' })
	expect(
		restoreReadableMcpOAuthTokens({
			blob: undefined,
			sources: [
				{ refresh_token: 'sidecar-rt' },
				{ access_token: 'sibling-at' },
			],
		}),
	).toEqual({ access_token: 'sibling-at', refresh_token: 'sidecar-rt' })
})

test('token recovery lastError names refresh failure without claiming IdP just succeeded', () => {
	const rejected = buildMcpOAuthTokenRecoveryLastError({
		authUrl: 'https://mediarss.example/admin/authorize',
		mcpEndpoint: 'https://mediarss.example/mcp?code=secret',
		hadRefreshToken: true,
		stillHasRefreshToken: false,
		attemptId: '11111111-1111-4111-8111-111111111111',
		at: '2026-09-14T00:00:00.000Z',
	})
	expect(rejected.phase).toBe('token exchange')
	expect(rejected.mcpEndpoint).toBe('https://mediarss.example/mcp')
	expect(rejected.message).toContain('could not be refreshed')
	expect(rejected.message).toContain('rejected or consumed the refresh token')
	expect(rejected.message).not.toContain('Authorization completed')
	expect(rejected.message).toContain('id 11111111-1111-4111-8111-111111111111')

	const noRefresh = buildMcpOAuthTokenRecoveryLastError({
		authUrl: null,
		hadRefreshToken: false,
		stillHasRefreshToken: false,
		attemptId: '22222222-2222-4222-8222-222222222222',
	})
	expect(noRefresh.message).toContain('has no refresh token to renew')
	expect(
		describeMcpOAuthTokenRecovery({
			hadRefreshToken: true,
			stillHasRefreshToken: true,
		}),
	).toContain('Refresh did not restore the connection')
	const incoming = { access_token: 'new-at' }
	expect([
		mergeMcpOAuthTokens({
			incoming,
			existing: { access_token: 'old-at', refresh_token: 'keep-rt' },
		}),
		mergeMcpOAuthTokens({
			incoming: { ...incoming, refresh_token: 'rotated-rt' },
			existing: { refresh_token: 'old-rt' },
		}),
		mergeMcpOAuthTokens({ incoming, existing: { access_token: 'old-at' } }),
	]).toEqual([
		{ access_token: 'new-at', refresh_token: 'keep-rt' },
		{ access_token: 'new-at', refresh_token: 'rotated-rt' },
		{ access_token: 'new-at' },
	])
	expect(
		isMcpOAuthTokenRecoveryLastError({
			message: 'Authorization completed at the identity provider, but hung',
			phase: 'token exchange',
			httpStatus: null,
			httpBodySnippet: null,
			mcpEndpoint: null,
			resource: null,
			authServer: null,
			attemptId: 'unknown',
			at: '2026-01-01T00:00:00.000Z',
		}),
	).toBe(false)

	const omitted = buildMcpOAuthMissingRefreshGrantLastError({
		authUrl: null,
		mcpEndpoint: 'https://kody-home.doddsfamily.us/mcp',
		attemptId: '33333333-3333-4333-8333-333333333333',
		at: '2026-09-16T00:00:00.000Z',
	})
	expect(omitted.phase).toBe('token exchange')
	expect(omitted.message).not.toContain('Authorization completed')
	expect(isMcpOAuthTokenRecoveryLastError(omitted)).toBe(false)
	expect(isMcpOAuthGrantIssueLastError(noRefresh)).toBe(true)
})
