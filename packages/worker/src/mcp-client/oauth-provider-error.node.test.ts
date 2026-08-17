import { expect, test } from 'vitest'
import { enrichMcpOAuthProviderError } from './oauth-provider-error.ts'

const oauth = {
	clientOrigin: 'https://kody.codes',
	callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	clientMetadataUrl: 'https://kody.codes/oauth/client-metadata.json',
}

test('origin rejections include CIMD when Kody presents one', () => {
	const message = enrichMcpOAuthProviderError(
		'Invalid origin uri https://kody.codes',
		oauth,
	)
	expect(message).toContain('Invalid origin uri https://kody.codes')
	expect(message).toContain(oauth.clientOrigin)
	expect(message).toContain(oauth.callbackUrl)
	expect(message).toContain(oauth.clientMetadataUrl)
})

test('origin rejections omit CIMD when Kody is on DCR only', () => {
	const message = enrichMcpOAuthProviderError(
		'Invalid origin uri http://localhost:8787',
		{
			clientOrigin: 'http://localhost:8787',
			callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
			clientMetadataUrl: null,
		},
	)
	expect(message).toContain('http://localhost:8787')
	expect(message).not.toContain('CIMD')
	expect(message).not.toContain('client-metadata.json')
})

test('unrelated OAuth errors stay unchanged', () => {
	expect(enrichMcpOAuthProviderError('Invalid state.', oauth)).toBe(
		'Invalid state.',
	)
})
