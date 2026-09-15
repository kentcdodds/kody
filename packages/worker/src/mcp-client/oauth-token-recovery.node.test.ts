import { expect, test } from 'vitest'
import {
	buildMcpOAuthTokenRecoveryLastError,
	describeMcpOAuthTokenRecovery,
	isMcpOAuthTokenRecoveryLastError,
	mcpOAuthTokenRecoveryStorageKey,
	mergeMcpOAuthTokens,
	readMcpOAuthTokenPresence,
	shouldAttemptMcpOAuthRefresh,
	shouldQueueMcpTokenRecoveryDisconnected,
} from './oauth-token-recovery.ts'

test('token recovery inspects stored OAuth blobs without treating empty strings as tokens', () => {
	expect(readMcpOAuthTokenPresence(null)).toEqual({
		hasAccessToken: false,
		hasRefreshToken: false,
	})
	expect(
		readMcpOAuthTokenPresence({
			access_token: '  ',
			refresh_token: '',
		}),
	).toEqual({
		hasAccessToken: false,
		hasRefreshToken: false,
	})
	expect(
		readMcpOAuthTokenPresence({
			access_token: 'at',
			refresh_token: 'rt',
		}),
	).toEqual({
		hasAccessToken: true,
		hasRefreshToken: true,
	})
	expect(
		shouldAttemptMcpOAuthRefresh({
			hasAccessToken: true,
			hasRefreshToken: false,
		}),
	).toBe(true)
	expect(
		shouldAttemptMcpOAuthRefresh({
			hasAccessToken: false,
			hasRefreshToken: false,
		}),
	).toBe(false)
	expect(
		shouldQueueMcpTokenRecoveryDisconnected({
			wasReady: false,
			presence: { hasAccessToken: true, hasRefreshToken: false },
			hasTokenRecoveryLastError: false,
		}),
	).toBe(true)
	expect(
		shouldQueueMcpTokenRecoveryDisconnected({
			wasReady: false,
			presence: { hasAccessToken: false, hasRefreshToken: false },
			hasTokenRecoveryLastError: true,
		}),
	).toBe(true)
	expect(
		shouldQueueMcpTokenRecoveryDisconnected({
			wasReady: false,
			presence: { hasAccessToken: false, hasRefreshToken: false },
			hasTokenRecoveryLastError: false,
		}),
	).toBe(false)
	expect(mcpOAuthTokenRecoveryStorageKey('server-1')).toBe(
		'mcp-oauth-token-recovery/server-1',
	)
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
	expect(
		mergeMcpOAuthTokens({
			incoming: { access_token: 'new-at' },
			existing: { access_token: 'old-at', refresh_token: 'keep-rt' },
		}),
	).toEqual({ access_token: 'new-at', refresh_token: 'keep-rt' })
	expect(
		mergeMcpOAuthTokens({
			incoming: { access_token: 'new-at', refresh_token: 'rotated-rt' },
			existing: { refresh_token: 'old-rt' },
		}),
	).toEqual({ access_token: 'new-at', refresh_token: 'rotated-rt' })
	expect(
		mergeMcpOAuthTokens({
			incoming: { access_token: 'new-at' },
			existing: { access_token: 'old-at' },
		}),
	).toEqual({ access_token: 'new-at' })
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
})
