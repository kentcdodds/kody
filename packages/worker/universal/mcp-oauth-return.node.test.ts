import { expect, test } from 'vitest'
import {
	mcpOAuthChannelName,
	mcpOAuthPopupName,
	mcpOAuthReturnCookie,
	mcpOAuthReturnCookieName,
	mcpOAuthReturnOnboarding,
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
	expect(mcpOAuthPopupName).toBe('kody-mcp-oauth')
	expect(mcpOAuthChannelName).toBe('kody-mcp-oauth')
})
