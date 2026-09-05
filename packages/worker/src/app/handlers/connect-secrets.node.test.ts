import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { createConnectSecretsHandler } from '#app/handlers/connect-secrets.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	loadAccountSecretsData: vi.fn<() => Promise<unknown>>(),
	renderAppPage: vi.fn<(input: unknown) => Promise<Response>>(),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/account-secrets-data.ts', () => ({
	loadAccountSecretsData: (...args: Array<unknown>) =>
		mockModule.loadAccountSecretsData(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: unknown) => mockModule.renderAppPage(input),
}))

test('connect secrets page requires a signed-in user and embeds approval data', async () => {
	const env = {} as Env
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(
		Response.redirect(
			'https://example.com/login?redirectTo=%2Fconnect%2Fsecrets',
			302,
		),
	)
	const unauthenticated = await createConnectSecretsHandler(env).handler(
		new RequestContext(new Request('https://example.com/connect/secrets')),
	)
	expect(unauthenticated.status).toBe(302)
	expect(unauthenticated.headers.get('location')).toContain('/login')

	const user = { mcpUser: { userId: 'user-1' } }
	const accountSecrets = {
		ok: true,
		approval: {
			name: 'cloudflareToken',
			names: ['cloudflareToken'],
			requestedHosts: ['api.cloudflare.com'],
		},
		approvalError: null,
	}
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(user)
	mockModule.loadAccountSecretsData.mockResolvedValue(accountSecrets)
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	const response = await createConnectSecretsHandler(env).handler(
		new RequestContext(
			new Request(
				'https://example.com/connect/secrets?name=cloudflareToken&hosts=api.cloudflare.com',
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
			title: 'Allow secret hosts',
			loaderData: { accountSecrets },
		}),
	)
})
