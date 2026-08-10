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
	hasStoredConnectClientSecret: vi.fn<() => Promise<boolean>>(),
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
	hasStoredConnectClientSecret: (...args: Array<unknown>) =>
		mockModule.hasStoredConnectClientSecret(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: unknown) => mockModule.renderAppPage(input),
}))

test('bare visits redirect to the OAuth guide and provider visits require a session', async () => {
	const env = {} as Env
	const bare = (search: string) =>
		isBareConnectOauthVisit(
			new URL(`https://example.com/connect/oauth${search}`),
		)
	expect(bare('')).toBe(true)
	expect(bare('?state=abc')).toBe(true)
	expect(bare('?provider=github')).toBe(false)
	expect(bare('?code=auth-code&state=abc')).toBe(false)
	expect(bare('?error=access_denied&state=abc')).toBe(false)

	const bareResponse = await createConnectOauthHandler(env).handler(
		new RequestContext(new Request('https://example.com/connect/oauth')),
	)
	expect(bareResponse.status).toBe(302)
	expect(bareResponse.headers.get('location')).toBe(
		'https://example.com/guides/oauth',
	)

	mockModule.requirePageSession.mockResolvedValue(
		Response.redirect('https://example.com/login', 302),
	)
	const gatedResponse = await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?provider=github'),
		),
	)
	expect(gatedResponse.status).toBe(302)
	expect(gatedResponse.headers.get('location')).toContain('/login')
})

test('provider visits embed SSR loader data and honor platform lookup flags', async () => {
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
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(true)

	await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?provider=GitHub'),
		),
	)
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
					hasStoredClientSecret: true,
					redirectUri: 'https://example.com/connect/oauth',
				},
			},
		}),
	)

	mockModule.loadAccountIntegrationByName.mockResolvedValue({
		name: 'google',
		platform: true,
	})
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(false)

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

test('callback embeds only the redirect URI without an integration lookup', async () => {
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
		expect.objectContaining({
			loaderData: {
				connectOauth: {
					ok: true,
					provider: null,
					integration: null,
					redirectUri: 'https://example.com/connect/oauth',
				},
			},
		}),
	)
})
