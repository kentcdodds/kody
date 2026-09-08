import { expect, test } from 'vitest'
import {
	buildIncompleteDiscoverLastError,
	buildMcpServerLastError,
	formatMcpOAuthSettleErrorMessage,
	inferMcpOAuthSettlePhase,
	isFormattedMcpOAuthSettleMessage,
	parseHttpStatusFromMcpError,
	parseStoredMcpServerLastError,
	readAttemptIdFromSettleMessage,
	readOAuthDiscoveryUrls,
	sanitizeMcpErrorSnippet,
	sanitizePublicUrl,
	stringifyMcpServerLastError,
} from './oauth-settle-error.ts'

test('settle error helpers sanitize secrets and keep observable phases', () => {
	expect(sanitizePublicUrl('https://mcp.example/mcp?code=abc#frag')).toBe(
		'https://mcp.example/mcp',
	)
	expect(
		sanitizeMcpErrorSnippet(
			'HTTP 403 Forbidden Bearer secret-token access_token=abc eyJhbGciOiJIUzI1NiJ9.aaa.bbb',
		),
	).toContain('Bearer [redacted]')
	expect(
		sanitizeMcpErrorSnippet(
			'HTTP 403 Forbidden Bearer secret-token access_token=abc',
		),
	).not.toContain('secret-token')
	expect(
		sanitizeMcpErrorSnippet(
			'{"access_token":"secret-token","refresh_token":"rt-secret","client_secret":"cs-secret"}',
		),
	).toBe(
		'{"access_token":"[redacted]","refresh_token":"[redacted]","client_secret":"[redacted]"}',
	)
	expect(
		sanitizeMcpErrorSnippet(
			'{ "access_token" : "secret-token", "refresh_token" : "rt-secret" }',
		),
	).not.toMatch(/secret-token|rt-secret/)
	expect(
		parseHttpStatusFromMcpError('upstream HTTP 403: missing audience'),
	).toBe(403)
	expect(
		inferMcpOAuthSettlePhase({
			state: 'connected',
			error: null,
		}),
	).toBe('server/discover')
	expect(
		inferMcpOAuthSettlePhase({
			state: 'discovering',
			error: null,
		}),
	).toBe('tools/list')
	expect(
		inferMcpOAuthSettlePhase({
			state: 'failed',
			error: 'Protected resource metadata HTTP 401',
		}),
	).toBe('resource metadata')
	expect(
		buildIncompleteDiscoverLastError({
			state: 'connected',
			mcpEndpoint: 'https://mcp.example/mcp',
			attemptId: 'attempt-discover',
		})?.phase,
	).toBe('server/discover')
	expect(
		buildIncompleteDiscoverLastError({
			state: 'discovering',
			mcpEndpoint: 'https://mcp.example/mcp',
			attemptId: 'attempt-tools',
		}),
	).toMatchObject({
		phase: 'tools/list',
		attemptId: 'attempt-tools',
		mcpEndpoint: 'https://mcp.example/mcp',
	})
	expect(
		buildIncompleteDiscoverLastError({
			state: 'connected',
			mcpEndpoint: 'https://mcp.example/mcp',
			attemptId: 'attempt-catalog',
			phase: 'tools/list',
		})?.phase,
	).toBe('tools/list')
	expect(
		buildIncompleteDiscoverLastError({
			state: 'ready',
			mcpEndpoint: 'https://mcp.example/mcp',
		}),
	).toBeNull()

	const lastError = buildMcpServerLastError({
		state: 'connected',
		authUrl: null,
		error: 'HTTP 403 insufficient_scope access_token=leak',
		httpBodySnippet: 'insufficient_scope',
		mcpEndpoint: 'https://mcp.example/mcp?token=abc',
		resource: 'https://mcp.example/',
		authServer: 'https://auth.example/',
		attemptId: 'attempt-1',
		at: '2026-09-08T00:00:00.000Z',
	})
	expect(lastError.message).toContain('HTTP 403')
	expect(lastError.message).toContain('phase server/discover')
	expect(lastError.message).not.toContain('access_token=leak')
	expect(lastError.mcpEndpoint).toBe('https://mcp.example/mcp')

	const stored = parseStoredMcpServerLastError(
		stringifyMcpServerLastError(lastError),
	)
	expect(stored).toEqual(lastError)
	expect(parseStoredMcpServerLastError('plain leftover')).toMatchObject({
		message: 'plain leftover',
		phase: null,
	})
	expect(
		readOAuthDiscoveryUrls({
			resource: 'https://mcp.example/?code=abc',
			authorization_servers: ['https://auth.example/?client_secret=x'],
		}),
	).toEqual({
		resource: 'https://mcp.example/',
		authServer: 'https://auth.example/',
	})

	const formatted = formatMcpOAuthSettleErrorMessage({
		state: 'connected',
		authUrl: null,
		mcpEndpoint: 'https://mcp.example/mcp',
		attemptId: '11111111-1111-4111-8111-111111111111',
	})
	expect(isFormattedMcpOAuthSettleMessage(formatted)).toBe(true)
	expect(readAttemptIdFromSettleMessage(formatted)).toBe(
		'11111111-1111-4111-8111-111111111111',
	)
	const wrapped = formatMcpOAuthSettleErrorMessage({
		state: 'connected',
		authUrl: null,
		error: formatted,
		mcpEndpoint: 'https://mcp.example/mcp',
		resource: 'https://mcp.example/',
		attemptId: '11111111-1111-4111-8111-111111111111',
	})
	expect(wrapped.match(/authorization completed/gi)?.length).toBe(1)
	expect(wrapped.match(/\bphase\s/g)?.length).toBe(1)
	expect(wrapped.match(/\bid\s/g)?.length).toBe(1)
	expect(wrapped).toContain('id 11111111-1111-4111-8111-111111111111')
})
