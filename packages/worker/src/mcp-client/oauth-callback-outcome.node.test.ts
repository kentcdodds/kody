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

	const stuckAuthenticating = resolveMcpOAuthCallbackOutcome({
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
	expect(stuckAuthenticating.authSuccess).toBe(false)
	expect(stuckAuthenticating.authError).toBeTruthy()
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

	const waitingForAuth = describeIncompleteMcpOAuthConnection({
		state: 'authenticating',
		authUrl: 'https://auth.example/authorize',
	})
	const missingAuthUrl = describeIncompleteMcpOAuthConnection({
		state: 'authenticating',
		authUrl: null,
	})
	const connecting = describeIncompleteMcpOAuthConnection({
		state: 'connecting',
		authUrl: null,
	})
	expect(waitingForAuth).not.toEqual(missingAuthUrl)
	expect(connecting).not.toEqual(waitingForAuth)
	expect(connecting).not.toEqual(missingAuthUrl)
})
