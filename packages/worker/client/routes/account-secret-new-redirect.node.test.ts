import { expect, test, vi } from 'vitest'
import { RouteLoaderRedirect } from '#client/route-loader.ts'
import { accountSecretsRouteLoader } from './account-secrets-shared.ts'

test('account secrets loader redirects prefilled /new links and keeps bare /new on the editor', async () => {
	const fetchMock = vi.fn(async () =>
		Response.json({
			ok: true,
			email: 'user@example.com',
			packageOptions: [],
			packages: [],
			secrets: [],
			selectedSecret: null,
			approval: null,
			approvalError: null,
		}),
	)
	vi.stubGlobal('fetch', fetchMock)

	const redirected = await accountSecretsRouteLoader(
		new URL(
			'https://example.com/account/secrets/new?name=exampleApiKey&allowedHosts=api.example.com',
		),
		new AbortController().signal,
	)
	expect(redirected).toBeInstanceOf(RouteLoaderRedirect)
	expect((redirected as RouteLoaderRedirect).to).toBe(
		'/connect/secret-set?name=exampleApiKey&allowedHosts=api.example.com',
	)
	expect(fetchMock).not.toHaveBeenCalled()

	const bare = await accountSecretsRouteLoader(
		new URL('https://example.com/account/secrets/new'),
		new AbortController().signal,
	)
	expect(bare).toEqual({
		accountSecrets: expect.objectContaining({ ok: true }),
	})
	expect(fetchMock).toHaveBeenCalled()
	vi.unstubAllGlobals()
})
