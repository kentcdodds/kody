import { expect, test, vi } from 'vitest'

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: async () => ({
		username: 'jane',
		request: { org: { slug: 'acme' } },
	}),
}))

const { createConnectCredentialHandler } =
	await import('./connect-credential.ts')

test('the org-less creation link sends the person to their org page, uncached', async () => {
	const url = 'https://example.com/connect/credential?kind=secret&name=KEY'
	const response = await createConnectCredentialHandler({} as Env).handler({
		request: new Request(url),
		url: new URL(url),
		params: {},
	} as never)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toBe(
		'/@acme/-/credentials/new?kind=secret&name=KEY',
	)
	expect(response.headers.get('cache-control')).toBe('private, no-store')
})
