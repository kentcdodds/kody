import { expect, test } from 'vitest'
import { enrichMcpOAuthProviderError } from './oauth-provider-error.ts'

const callback = {
	callbackUrl: 'https://heykody.app/account/mcp-servers/oauth/callback',
	clientOrigin: 'https://heykody.app',
}

test('enrichMcpOAuthProviderError explains FusionAuth-style origin rejection', () => {
	const enriched = enrichMcpOAuthProviderError(
		'Invalid origin uri https://heykody.app',
		callback,
	)
	expect(enriched).toContain('Invalid origin uri https://heykody.app')
	expect(enriched).toContain('https://heykody.app')
	expect(enriched).toContain(callback.callbackUrl)
	expect(enriched).toContain('operate this MCP server')
})

test('enrichMcpOAuthProviderError explains redirect URI rejection', () => {
	const enriched = enrichMcpOAuthProviderError(
		'invalid_redirect_uri: redirect_uri mismatch',
		callback,
	)
	expect(enriched).toContain(callback.callbackUrl)
})

test('enrichMcpOAuthProviderError leaves unrelated errors unchanged', () => {
	expect(enrichMcpOAuthProviderError('Invalid state format', callback)).toBe(
		'Invalid state format',
	)
	expect(enrichMcpOAuthProviderError('  ', callback)).toBe('')
})
