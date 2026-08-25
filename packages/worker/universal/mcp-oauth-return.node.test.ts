import { expect, test } from 'vitest'
import {
	mcpOAuthMessageType,
	mcpOAuthReturnCookie,
	mcpOAuthReturnCookieName,
	mcpOAuthReturnOnboarding,
	readMcpOAuthDoneMessage,
	readMcpOAuthReturnCookie,
} from './mcp-oauth-return.ts'

test('readMcpOAuthReturnCookie finds the onboarding return marker', () => {
	expect(readMcpOAuthReturnCookie(null)).toBeNull()
	expect(readMcpOAuthReturnCookie('session=abc')).toBeNull()
	expect(
		readMcpOAuthReturnCookie(
			`other=1; ${mcpOAuthReturnCookieName}=${mcpOAuthReturnOnboarding}; sid=z`,
		),
	).toBe(mcpOAuthReturnOnboarding)
	expect(
		mcpOAuthReturnCookie({ value: mcpOAuthReturnOnboarding, secure: true }),
	).toContain('Secure')
	expect(mcpOAuthReturnCookie({ value: '', secure: false })).toContain(
		'Max-Age=0',
	)
	expect(mcpOAuthReturnCookie({ value: '', secure: false })).toContain(
		`${mcpOAuthReturnCookieName}=;`,
	)
	expect(
		readMcpOAuthDoneMessage({
			type: mcpOAuthMessageType,
			auth: 'error',
			reason: 'Supported sites required.',
			server: 'atlassian',
		}),
	).toMatchObject({
		type: mcpOAuthMessageType,
		auth: 'error',
		server: 'atlassian',
	})
	expect(readMcpOAuthDoneMessage({ type: 'other' })).toBeNull()
})
