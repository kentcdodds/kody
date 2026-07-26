import { expect, test } from 'vitest'
import {
	describeIncompleteMcpOAuthConnection,
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'

test('OAuth callback success requires the MCP connection to be ready', () => {
	expect(
		resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: true,
			sdkAuthError: null,
			serverId: 'server-1',
			serverName: 'recipe-keeper',
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
	})
})

test('OAuth callback does not report success when left authenticating without authUrl', () => {
	const outcome = resolveMcpOAuthCallbackOutcome({
		sdkAuthSuccess: true,
		sdkAuthError: null,
		serverId: 'server-1',
		serverName: 'recipe-keeper',
		connection: {
			state: 'authenticating',
			authUrl: null,
			error: null,
		},
	})

	expect(outcome.authSuccess).toBe(false)
	expect(outcome.serverId).toBe('server-1')
	expect(outcome.serverName).toBe('recipe-keeper')
	expect(outcome.authError).toContain('no authorization link')
	expect(
		isStuckMcpAuthenticatingWithoutAuthUrl({
			state: 'authenticating',
			authUrl: null,
		}),
	).toBe(true)
})

test('OAuth callback surfaces connection errors after SDK authSuccess', () => {
	expect(
		resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: true,
			sdkAuthError: null,
			serverId: 'server-1',
			serverName: 'recipe-keeper',
			connection: {
				state: 'failed',
				authUrl: null,
				error: 'Token exchange failed.',
			},
		}),
	).toEqual({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Token exchange failed.',
		serverName: 'recipe-keeper',
	})
})

test('OAuth callback keeps SDK failures as failures', () => {
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
	})
})

test('incomplete OAuth connection messages distinguish missing auth URLs', () => {
	expect(
		describeIncompleteMcpOAuthConnection({
			state: 'authenticating',
			authUrl: 'https://auth.example/authorize',
		}),
	).toContain('still requires authorization')
	expect(
		describeIncompleteMcpOAuthConnection({
			state: 'authenticating',
			authUrl: null,
		}),
	).toContain('no authorization link')
	expect(
		describeIncompleteMcpOAuthConnection({
			state: 'connecting',
			authUrl: null,
		}),
	).toContain('"connecting"')
})
