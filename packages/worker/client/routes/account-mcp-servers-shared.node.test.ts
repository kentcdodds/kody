import { expect, test } from 'vitest'
import { readOAuthResultFromHref } from './account-mcp-servers-shared.tsx'

test('OAuth callback reason keeps named allowlist failures intact', () => {
	const result = readOAuthResultFromHref(
		`/account/mcp-servers?auth=error&reason=${encodeURIComponent('invalid_redirect_uri')}`,
	)
	expect(result).toEqual({
		message: 'invalid_redirect_uri',
		tone: 'error',
	})

	const other = readOAuthResultFromHref(
		'/account/mcp-servers?auth=error&reason=Invalid%20state.',
	)
	expect(other).toEqual({
		message: 'MCP server authorization failed: Invalid state.',
		tone: 'error',
	})
})
