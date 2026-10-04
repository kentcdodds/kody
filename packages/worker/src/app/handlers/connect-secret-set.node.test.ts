import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import type * as AccountSecretsData from '#app/account-secrets-data.ts'
import type * as PageAuth from '#app/page-auth.ts'
import { createConnectSecretSetHandler } from '#app/handlers/connect-secret-set.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser:
		vi.fn<
			(
				...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
			) => Promise<unknown>
		>(),
	loadAccountSecretsData:
		vi.fn<
			(
				...args: Parameters<typeof AccountSecretsData.loadAccountSecretsData>
			) => Promise<unknown>
		>(),
	renderAppPage: vi.fn<(input: unknown) => Promise<Response>>(),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (
		...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
	) => mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/account-secrets-data.ts', () => ({
	loadAccountSecretsData: (
		...args: Parameters<typeof AccountSecretsData.loadAccountSecretsData>
	) => mockModule.loadAccountSecretsData(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: unknown) => mockModule.renderAppPage(input),
}))

test('connect secret-set page requires a signed-in user and embeds secrets data', async () => {
	const env = {} as Env
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(
		Response.redirect(
			'https://example.com/login?redirectTo=%2Fconnect%2Fsecret-set',
			302,
		),
	)
	const unauthenticated = await createConnectSecretSetHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/secret-set?name=exampleApiKey'),
		),
	)
	expect(unauthenticated.status).toBe(302)
	expect(unauthenticated.headers.get('location')).toContain('/login')

	const user = { mcpUser: { userId: 'user-1' } }
	const accountSecrets = {
		ok: true,
		packageOptions: [],
		packages: [],
		secrets: [],
		selectedSecret: null,
		approval: null,
		approvalError: null,
	}
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(user)
	mockModule.loadAccountSecretsData.mockResolvedValue(accountSecrets)
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	const response = await createConnectSecretSetHandler(env).handler(
		new RequestContext(
			new Request(
				'https://example.com/connect/secret-set?name=exampleApiKey&allowedHosts=api.example.com',
			),
		),
	)
	expect(response.status).toBe(200)
	expect(mockModule.loadAccountSecretsData).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			user,
		}),
	)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: 'Set secret',
			loaderData: { accountSecrets },
		}),
	)
})
