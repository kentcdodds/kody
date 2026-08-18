import { expect, test } from 'vitest'
import { enrichMcpOAuthProviderError } from './oauth-provider-error.ts'

test('origin rejections include CIMD details when present and leave unrelated errors alone', () => {
	const oauth = {
		clientOrigin: 'https://kody.codes',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
		clientMetadataUrl: 'https://kody.codes/oauth/client-metadata.json',
	}
	const withCimd = enrichMcpOAuthProviderError(
		'Invalid origin uri https://kody.codes',
		oauth,
	)
	expect(withCimd).toContain('Invalid origin uri https://kody.codes')
	expect(withCimd).toContain(oauth.clientMetadataUrl)

	const withoutCimd = enrichMcpOAuthProviderError(
		'Invalid origin uri http://localhost:8787',
		{
			clientOrigin: 'http://localhost:8787',
			callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
			clientMetadataUrl: null,
		},
	)
	expect(withoutCimd).toContain('http://localhost:8787')
	expect(withoutCimd).not.toContain('client-metadata.json')

	expect(enrichMcpOAuthProviderError('Invalid state.', oauth)).toBe(
		'Invalid state.',
	)
})
