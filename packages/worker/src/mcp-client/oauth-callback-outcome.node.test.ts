import { expect, test } from 'vitest'
import {
	describeIncompleteMcpOAuthConnection,
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'

type OutcomeInput = Parameters<typeof resolveMcpOAuthCallbackOutcome>[0]

function resolve(
	connection: Partial<OutcomeInput['connection']>,
	overrides: Partial<Omit<OutcomeInput, 'connection'>> = {},
) {
	return resolveMcpOAuthCallbackOutcome({
		sdkAuthSuccess: true,
		sdkAuthError: null,
		serverId: 'server-1',
		serverName: 'recipe-keeper',
		...overrides,
		connection: {
			state: 'connected',
			authUrl: null,
			error: null,
			...connection,
		},
	} as OutcomeInput)
}

const posthog = { serverId: 'server-posthog', serverName: 'posthog' }

function countMatches(text: string | null | undefined, pattern: RegExp) {
	return text?.match(pattern)?.length
}

test('OAuth callback outcome requires a ready connection after SDK success', () => {
	expect(resolve({ state: 'ready' }, { attemptId: 'attempt-ready' })).toEqual({
		serverId: 'server-1',
		authSuccess: true,
		authError: null,
		serverName: 'recipe-keeper',
		authorizationNeeded: false,
		lastError: null,
	})

	const stuckAuthenticating = resolve(
		{ state: 'authenticating' },
		{ attemptId: 'attempt-auth' },
	)
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
		resolve(
			{ state: 'failed', error: 'Token exchange failed.' },
			{ attemptId: 'attempt-token' },
		),
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
		resolve(
			{ state: 'authenticating', authUrl: 'https://auth.example/authorize' },
			{ sdkAuthSuccess: false, sdkAuthError: 'Invalid state' },
		),
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
	const outcome = resolve(
		{
			mcpEndpoint: 'https://mcp.posthog.com/mcp?code=secret-token',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/?client_secret=hidden',
		},
		{ ...posthog, attemptId: 'attempt-adam' },
	)

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
	expect(outcome.authError).not.toContain('secret-token')
	expect(outcome.authError).not.toContain('client_secret')
	expect(countMatches(outcome.authError, /authorization completed/gi)).toBe(1)
	expect(countMatches(outcome.authError, /\bphase\s/g)).toBe(1)

	const alreadyFormatted = resolve(
		{
			error: outcome.authError,
			mcpEndpoint: 'https://mcp.posthog.com/mcp',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/',
		},
		{ ...posthog, attemptId: 'attempt-adam' },
	)
	expect(
		countMatches(alreadyFormatted.authError, /authorization completed/gi),
	).toBe(1)
	expect(countMatches(alreadyFormatted.authError, /\bphase\s/g)).toBe(1)
	expect(alreadyFormatted.lastError?.attemptId).toBe('attempt-adam')

	const discovering = describeIncompleteMcpOAuthConnection({
		state: 'discovering',
		authUrl: null,
		error: null,
		attemptId: 'attempt-discovering',
	})
	expect(discovering).toContain("tool discovery didn't finish")
	expect(discovering).toContain('phase tools/list')

	const catalogTimeout = resolve(
		{ phase: 'tools/list', mcpEndpoint: 'https://analytics.example/mcp' },
		{
			serverId: 'server-catalog',
			serverName: 'analytics',
			attemptId: 'attempt-catalog',
		},
	)
	expect(catalogTimeout.lastError?.phase).toBe('tools/list')
	expect(catalogTimeout.authError).toContain('phase tools/list')
})
