import { expect, test } from 'vitest'
import {
	describeIncompleteMcpOAuthConnection,
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'

test('OAuth callback outcome requires a ready connection after SDK success', () => {
	expect(
		resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: true,
			sdkAuthError: null,
			serverId: 'server-1',
			serverName: 'recipe-keeper',
			attemptId: 'attempt-ready',
			connection: {
				state: 'ready',
				authUrl: null,
				error: null,
			},
		}),
	).toEqual({
		serverId: 'server-1',
		authSuccess: true,
		authError: null,
		serverName: 'recipe-keeper',
		authorizationNeeded: false,
		lastError: null,
	})

	const stuckAuthenticating = resolveMcpOAuthCallbackOutcome({
		sdkAuthSuccess: true,
		sdkAuthError: null,
		serverId: 'server-1',
		serverName: 'recipe-keeper',
		attemptId: 'attempt-auth',
		connection: {
			state: 'authenticating',
			authUrl: null,
			error: null,
		},
	})
	expect(stuckAuthenticating.authSuccess).toBe(false)
	expect(stuckAuthenticating.authError).toBeTruthy()
	expect(stuckAuthenticating.lastError?.phase).toBe('token exchange')
	expect(
		isStuckMcpAuthenticatingWithoutAuthUrl({
			state: 'authenticating',
			authUrl: null,
		}),
	).toBe(true)
	expect(
		isStuckMcpAuthenticatingWithoutAuthUrl({
			state: 'authenticating',
			authUrl: 'https://auth.example/authorize',
		}),
	).toBe(false)

	expect(
		resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: true,
			sdkAuthError: null,
			serverId: 'server-1',
			serverName: 'recipe-keeper',
			attemptId: 'attempt-token',
			connection: {
				state: 'failed',
				authUrl: null,
				error: 'Token exchange failed.',
			},
		}),
	).toMatchObject({
		serverId: 'server-1',
		authSuccess: false,
		authError: expect.stringContaining('token exchange failed'),
		serverName: 'recipe-keeper',
		authorizationNeeded: false,
		lastError: expect.objectContaining({
			phase: 'token exchange',
			attemptId: 'attempt-token',
		}),
	})

	expect(
		resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: false,
			sdkAuthError: 'Invalid state',
			serverId: 'server-1',
			serverName: 'recipe-keeper',
			connection: {
				state: 'authenticating',
				authUrl: 'https://auth.example/authorize',
				error: null,
			},
		}),
	).toEqual({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Invalid state',
		serverName: 'recipe-keeper',
		authorizationNeeded: false,
		lastError: null,
	})
})

test('IdP success with connected state and null connection.error is a tool-discovery lastError', () => {
	const outcome = resolveMcpOAuthCallbackOutcome({
		sdkAuthSuccess: true,
		sdkAuthError: null,
		serverId: 'server-posthog',
		serverName: 'posthog',
		attemptId: 'attempt-adam',
		connection: {
			state: 'connected',
			authUrl: null,
			error: null,
			mcpEndpoint: 'https://mcp.posthog.com/mcp?code=secret-token',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/?client_secret=hidden',
		},
	})

	expect(outcome.authSuccess).toBe(false)
	expect(outcome.lastError).toMatchObject({
		phase: 'server/discover',
		attemptId: 'attempt-adam',
		mcpEndpoint: 'https://mcp.posthog.com/mcp',
		resource: 'https://mcp.posthog.com/',
		authServer: 'https://auth.posthog.com/',
	})
	expect(outcome.authError).toBe(outcome.lastError?.message)
	expect(outcome.authError).toContain("tool discovery didn't finish")
	expect(outcome.authError).toContain('phase server/discover')
	expect(outcome.authError).toContain('id attempt-adam')
	expect(outcome.authError).not.toContain('still "connected"')
	expect(outcome.authError).not.toContain('secret-token')
	expect(outcome.authError).not.toContain('client_secret')

	const discovering = describeIncompleteMcpOAuthConnection({
		state: 'discovering',
		authUrl: null,
		error: null,
		attemptId: 'attempt-discovering',
	})
	expect(discovering).toContain("tool discovery didn't finish")
	expect(discovering).toContain('phase tools/list')
	expect(discovering).not.toContain('still "discovering"')
})
