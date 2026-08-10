import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createConnectOauthHandler,
	isBareConnectOauthVisit,
} from '#app/handlers/connect-oauth.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	requirePageSession: vi.fn<() => Promise<Response | null>>(),
	loadAccountIntegrationByName: vi.fn<() => Promise<unknown>>(),
	hasAlternativeBuiltInApp: vi.fn<() => Promise<boolean>>(),
	loadExistingConnectionSummary: vi.fn<() => Promise<unknown>>(),
	renderAppPage: vi.fn<(input: unknown) => Promise<Response>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requirePageSession: (...args: Array<unknown>) =>
		mockModule.requirePageSession(...args),
}))

vi.mock('#app/account-integrations-data.ts', () => ({
	loadAccountIntegrationByName: (...args: Array<unknown>) =>
		mockModule.loadAccountIntegrationByName(...args),
	hasAlternativeBuiltInApp: (...args: Array<unknown>) =>
		mockModule.hasAlternativeBuiltInApp(...args),
	loadExistingConnectionSummary: (...args: Array<unknown>) =>
		mockModule.loadExistingConnectionSummary(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: unknown) => mockModule.renderAppPage(input),
}))

test('bare /connect/oauth visits redirect to the OAuth guide', async () => {
	const env = {} as Env
	const response = await createConnectOauthHandler(env).handler(
		new RequestContext(new Request('https://example.com/connect/oauth')),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toBe(
		'https://example.com/guides/oauth',
	)
})

test('provider, callback, and denial visits are not bare', () => {
	const bare = (search: string) =>
		isBareConnectOauthVisit(
			new URL(`https://example.com/connect/oauth${search}`),
		)
	expect(bare('')).toBe(true)
	expect(bare('?state=abc')).toBe(true)
	// Agent-built setup URLs and built-in connects.
	expect(bare('?provider=github')).toBe(false)
	// The provider's success redirect strips the config query; sessionStorage
	// restores it client-side.
	expect(bare('?code=auth-code&state=abc')).toBe(false)
	// The provider's denial redirect carries error instead of code.
	expect(bare('?error=access_denied&state=abc')).toBe(false)
})

test('anonymous visits with a provider still hit the session gate', async () => {
	const env = {} as Env
	mockModule.requirePageSession.mockResolvedValue(
		Response.redirect('https://example.com/login', 302),
	)
	const response = await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?provider=github'),
		),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toContain('/login')
})

test('provider visits embed the integration record as SSR loader data', async () => {
	const env = {} as Env
	const record = { name: 'github', platform: true }
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'user-1' },
	})
	mockModule.loadAccountIntegrationByName.mockResolvedValue(record)
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	mockModule.hasAlternativeBuiltInApp.mockResolvedValue(false)
	mockModule.loadExistingConnectionSummary.mockResolvedValue(null)

	await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?provider=GitHub'),
		),
	)
	// The provider param normalizes before the lookup, matching the client.
	expect(mockModule.loadAccountIntegrationByName).toHaveBeenCalledWith(
		env,
		expect.anything(),
		'github',
		{ preferPlatform: false, platformSlug: undefined },
	)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			loaderData: {
				connectOauth: {
					ok: true,
					provider: 'github',
					integration: record,
					builtInAvailable: false,
					existingConnection: null,
				},
			},
		}),
	)
})

test('platform=1 forces the built-in lookup', async () => {
	const env = {} as Env
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'user-1' },
	})
	mockModule.loadAccountIntegrationByName.mockResolvedValue({
		name: 'google',
		platform: true,
	})
	mockModule.hasAlternativeBuiltInApp.mockResolvedValue(false)
	mockModule.loadExistingConnectionSummary.mockResolvedValue(null)
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request(
				'https://example.com/connect/oauth?provider=google&platform=1',
			),
		),
	)
	expect(mockModule.loadAccountIntegrationByName).toHaveBeenLastCalledWith(
		env,
		expect.anything(),
		'google',
		{ preferPlatform: true, platformSlug: undefined },
	)

	// platform=<slug> connects that built-in under a different name.
	await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request(
				'https://example.com/connect/oauth?provider=google-2&platform=google',
			),
		),
	)
	expect(mockModule.loadAccountIntegrationByName).toHaveBeenLastCalledWith(
		env,
		expect.anything(),
		'google-2',
		{ preferPlatform: false, platformSlug: 'google' },
	)
})

test('callback returns render without loader data', async () => {
	const env = {} as Env
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.loadAccountIntegrationByName.mockClear()
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?code=auth-code&state=abc'),
		),
	)
	expect(mockModule.loadAccountIntegrationByName).not.toHaveBeenCalled()
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.not.objectContaining({ loaderData: expect.anything() }),
	)
})
