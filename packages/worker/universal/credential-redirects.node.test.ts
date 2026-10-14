import { expect, test } from 'vitest'
import { parseCredentialCreateQuery } from './credential-contracts.ts'
import { credentialRedirectFor } from './credential-redirects.ts'

const redirect = (path: string) =>
	credentialRedirectFor(new URL(path, 'https://kody.test'))

test('old org index pages go to the Credentials list filtered by kind', () => {
	expect(redirect('/@acme/-/secrets')).toBe('/@acme/-/credentials?kind=secret')
	expect(redirect('/@acme/-/secrets/')).toBe('/@acme/-/credentials?kind=secret')
	expect(redirect('/@acme/-/integrations')).toBe(
		'/@acme/-/credentials?kind=oauth',
	)
	expect(redirect('/@acme/-/mcp-servers?url=https%3A%2F%2Fmcp.test')).toBe(
		'/@acme/-/credentials?url=https%3A%2F%2Fmcp.test&kind=mcp',
	)
	expect(redirect('/@acme/-/secrets?kind=oauth&q=x')).toBe(
		'/@acme/-/credentials?kind=secret&q=x',
	)
	expect(redirect('/@jane%2Bold/-/secrets')).toBe(
		'/@jane%2Bold/-/credentials?kind=secret',
	)
})

test('deeper flows, /connect/oauth, Secret providers, and other sections keep serving', () => {
	for (const path of [
		'/@acme/-/secret-providers',
		'/@acme/-/secret-providers?q=vault',
		'/@acme/-/secrets/approve',
		'/@acme/-/secrets/approve?token=t',
		'/@acme/-/mcp-servers/srv-1/authorize',
		'/@acme/-/integrations/github',
		'/account/mcp-servers/oauth/callback',
		'/connect/oauth?provider=github',
		'/@acme/-/credentials',
		'/@acme/-/values',
		'/@acme/-/secretsx',
		'/@acme/secrets',
	]) {
		expect(redirect(path), path).toBeNull()
	}
})

test('/connect/secret-set becomes a secret creation link, package renamed', () => {
	const location = redirect(
		'/connect/secret-set?name=stripe&allowedHosts=api.stripe.com&package=pkg-1&allowedPackages=pkg-2&scope=user&kind=oauth',
	)
	const url = new URL(location!, 'https://kody.test')
	expect(url.pathname).toBe('/connect/credential')
	expect(url.searchParams.getAll('kind')).toEqual(['secret'])
	expect(url.searchParams.getAll('allowedPackages')).toEqual(['pkg-1', 'pkg-2'])
	expect(url.searchParams.has('package')).toBe(false)
	expect(url.searchParams.get('scope')).toBe('user')
	expect(parseCredentialCreateQuery(url.searchParams)).toMatchObject({
		kind: 'secret',
		name: 'stripe',
		allowedHosts: ['api.stripe.com'],
		packageKodyId: null,
	})
	expect(redirect('/connect/secret-set')).toBe(
		'/connect/credential?kind=secret',
	)
})
