import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import type * as PageAuth from '#app/page-auth.ts'
import { createAccountSecretsHandler } from '#app/handlers/account-secrets.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser:
		vi.fn<
			(
				...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
			) => Promise<unknown>
		>(),
	loadAccountSecretsData: vi.fn(async () => ({ ok: true })),
	renderAppPage: vi.fn(async () => new Response('secrets-list')),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (
		...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
	) => mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/account-secrets-data.ts', () => ({
	loadAccountSecretsData: () => mockModule.loadAccountSecretsData(),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: () => mockModule.renderAppPage(),
}))

test('prefilled /account/secrets/new redirects to focused /connect/secret-set', async () => {
	const env = {} as Env
	const response = await createAccountSecretsHandler(env).handler(
		new RequestContext(
			new Request(
				'https://example.com/account/secrets/new?name=exampleApiKey&allowedHosts=api.example.com',
			),
		),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toBe(
		'https://example.com/connect/secret-set?name=exampleApiKey&allowedHosts=api.example.com',
	)
	expect(mockModule.requireAuthenticatedPageUser).not.toHaveBeenCalled()
})

test('bare /account/secrets/new stays on the account secrets editor', async () => {
	const env = {} as Env
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		mcpUser: { userId: 'user-1' },
	})
	const response = await createAccountSecretsHandler(env).handler(
		new RequestContext(new Request('https://example.com/account/secrets/new')),
	)
	expect(response.status).toBe(200)
	expect(mockModule.renderAppPage).toHaveBeenCalled()
})
