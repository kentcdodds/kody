import { expect, test } from 'vitest'
import {
	describeMcpOAuthProviderError,
	enrichMcpOAuthProviderError,
	isMcpOAuthAllowlistRejection,
} from './mcp-oauth-provider-error.ts'

const kodyOauth = {
	clientOrigin: 'https://kody.codes',
	callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	clientMetadataUrl: 'https://kody.codes/oauth/client-metadata.json',
}

test('origin and redirect-URI rejections are named allowlist failures and leave other errors alone', () => {
	const origin = describeMcpOAuthProviderError(
		'Invalid origin uri https://kody.codes',
		kodyOauth,
	)
	expect(origin).toMatchObject({
		kind: 'allowlist',
		callbackUrl: kodyOauth.callbackUrl,
		vercelDocsUrl: null,
		vercelIssueUrl: null,
	})
	const originText = enrichMcpOAuthProviderError(
		'Invalid origin uri https://kody.codes',
		kodyOauth,
	)
	expect(originText).toContain('unapproved OAuth client')
	expect(originText).toContain('allowlist')
	expect(originText).toContain(kodyOauth.callbackUrl)
	expect(originText).toContain(kodyOauth.clientMetadataUrl)
	expect(originText).toContain('Invalid origin uri https://kody.codes')

	const localhost = enrichMcpOAuthProviderError(
		'Invalid origin uri http://localhost:8787',
		{
			clientOrigin: 'http://localhost:8787',
			callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
			clientMetadataUrl: null,
		},
	)
	expect(localhost).toContain(
		'http://localhost:8787/account/mcp-servers/oauth/callback',
	)
	expect(localhost).not.toContain('client-metadata.json')

	expect(enrichMcpOAuthProviderError('Invalid state.', kodyOauth)).toBe(
		'Invalid state.',
	)
	expect(isMcpOAuthAllowlistRejection('Invalid state.')).toBe(false)
	expect(isMcpOAuthAllowlistRejection('invalid_redirect_uri')).toBe(true)

	const atlassian = enrichMcpOAuthProviderError(
		'Supported sites required. Your account is not currently associated with a supported site.',
		kodyOauth,
	)
	expect(atlassian).toContain('Supported sites required.')
	expect(atlassian).toContain('Jira or Confluence Cloud site')
})

test('Vercel MCP redirect-URI rejection names the unapproved-client allowlist and points at docs', () => {
	const described = describeMcpOAuthProviderError('invalid_redirect_uri', {
		...kodyOauth,
		serverUrl: 'https://mcp.vercel.com',
	})
	expect(described).toMatchObject({
		kind: 'allowlist',
		callbackUrl: kodyOauth.callbackUrl,
		vercelDocsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
		vercelIssueUrl: 'https://github.com/kentcdodds/kody/issues/1986',
		providerMessage: 'invalid_redirect_uri',
	})

	const formatted = enrichMcpOAuthProviderError('invalid_redirect_uri', {
		...kodyOauth,
		serverUrl: 'https://mcp.vercel.com',
	})
	expect(formatted).toContain('unapproved OAuth client')
	expect(formatted).toContain('allowlist')
	expect(formatted).toContain(kodyOauth.callbackUrl)
	expect(formatted).toContain(
		'https://vercel.com/docs/agent-resources/vercel-mcp',
	)
	expect(formatted).toContain('https://github.com/kentcdodds/kody/issues/1986')
	expect(formatted).toContain('has not approved Kody')
	expect(formatted).not.toContain('If you operate this MCP server')

	const alreadyEnriched = enrichMcpOAuthProviderError(formatted, kodyOauth)
	expect(alreadyEnriched).toContain(
		'https://vercel.com/docs/agent-resources/vercel-mcp',
	)
	expect(alreadyEnriched).toContain(
		'https://github.com/kentcdodds/kody/issues/1986',
	)
	expect(alreadyEnriched).toContain('has not approved Kody')
	expect(alreadyEnriched).not.toContain('If you operate this MCP server')

	const vercelTextOnly =
		"Vercel has not approved Kody as an MCP client yet. See Vercel's supported clients (https://vercel.com/docs/agent-resources/vercel-mcp) and tracking issue https://github.com/kentcdodds/kody/issues/1986."
	expect(isMcpOAuthAllowlistRejection(vercelTextOnly)).toBe(true)
	const vercelWithoutServerUrl = describeMcpOAuthProviderError(vercelTextOnly, {
		...kodyOauth,
		serverUrl: null,
	})
	expect(vercelWithoutServerUrl).toMatchObject({
		kind: 'allowlist',
		callbackUrl: kodyOauth.callbackUrl,
		vercelDocsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
		vercelIssueUrl: 'https://github.com/kentcdodds/kody/issues/1986',
	})
})
