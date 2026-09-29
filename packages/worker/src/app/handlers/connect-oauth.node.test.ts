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
	loadExistingConnectionSummary: vi.fn<() => Promise<unknown>>(),
	hasStoredConnectClientSecret: vi.fn<() => Promise<boolean>>(),
	loadConnectOauthChooser: vi.fn(async () => ({ options: [] })),
	readConnectOauthLookupOptions: (searchParams: URLSearchParams) => {
		const appParam = searchParams.get('app')?.trim()
		return {
			appSlug: appParam || undefined,
		}
	},
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

vi.mock('#app/connect-oauth-chooser.ts', () => ({
	loadConnectOauthChooser: (...args: Array<unknown>) =>
		mockModule.loadConnectOauthChooser(...args),
}))

vi.mock('#app/account-integrations-data.ts', () => ({
	loadAccountIntegrationByName: (...args: Array<unknown>) =>
		mockModule.loadAccountIntegrationByName(...args),
	loadExistingConnectionSummary: (...args: Array<unknown>) =>
		mockModule.loadExistingConnectionSummary(...args),
	hasStoredConnectClientSecret: (...args: Array<unknown>) =>
		mockModule.hasStoredConnectClientSecret(...args),
	readConnectOauthLookupOptions: (searchParams: URLSearchParams) =>
		mockModule.readConnectOauthLookupOptions(searchParams),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: unknown) => mockModule.renderAppPage(input),
}))

const env = {} as Env

function visit(search = '') {
	return createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request(`https://example.com/connect/oauth${search}`),
		),
	)
}

function signIn() {
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'user-1' },
	})
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))
}

function renderedConnectOauth() {
	const input = mockModule.renderAppPage.mock.calls.at(-1)?.[0] as {
		loaderData: { connectOauth: unknown }
	}
	return input.loaderData.connectOauth
}

test('bare and provider visits require a session; signed-in bare visits render the chooser', async () => {
	const bareVisits = {
		'': true,
		'?state=abc': true,
		'?provider=github': false,
		'?code=auth-code&state=abc': false,
		'?error=access_denied&state=abc': false,
	}
	for (const [search, expected] of Object.entries(bareVisits)) {
		const isBare = isBareConnectOauthVisit(
			new URL(`https://example.com/connect/oauth${search}`),
		)
		expect({ search, isBare }).toEqual({ search, isBare: expected })
	}

	mockModule.requirePageSession.mockResolvedValue(
		Response.redirect(
			'https://example.com/login?redirectTo=%2Fconnect%2Foauth',
			302,
		),
	)
	for (const search of ['', '?provider=github']) {
		const gated = await visit(search)
		expect(gated.status).toBe(302)
		expect(gated.headers.get('location')).toContain('/login')
	}

	signIn()
	await visit()
	expect(renderedConnectOauth()).toMatchObject({
		ok: true,
		provider: null,
		integration: null,
		chooser: { options: [] },
	})
})

test('provider visits embed SSR loader data and ignore platform lookup flags', async () => {
	signIn()
	const record = { name: 'github', platform: true }
	mockModule.loadAccountIntegrationByName.mockResolvedValue(record)
	mockModule.loadExistingConnectionSummary.mockResolvedValue(null)
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(true)

	await visit('?provider=GitHub')
	expect(mockModule.loadAccountIntegrationByName).toHaveBeenCalledWith(
		env,
		expect.anything(),
		'github',
		{ appSlug: undefined },
	)
	expect(renderedConnectOauth()).toEqual({
		ok: true,
		provider: 'github',
		integration: record,
		builtInAvailable: false,
		existingConnection: null,
		hasStoredClientSecret: true,
		redirectUri: 'https://example.com/connect/oauth',
	})

	mockModule.loadAccountIntegrationByName.mockResolvedValue({
		name: 'google',
		platform: true,
	})
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(false)
	const lookups = [
		['?provider=google&platform=1', 'google', undefined],
		['?provider=google-2&platform=google', 'google-2', undefined],
		['?provider=work&app=google', 'work', 'google'],
	] as const
	for (const [search, name, appSlug] of lookups) {
		await visit(search)
		expect(mockModule.loadAccountIntegrationByName).toHaveBeenLastCalledWith(
			env,
			expect.anything(),
			name,
			{ appSlug },
		)
	}
})

test('callback embeds only the redirect URI without an integration lookup', async () => {
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.renderAppPage.mockResolvedValue(new Response('ok'))

	await visit('?code=auth-code&state=abc')
	expect(mockModule.loadAccountIntegrationByName).not.toHaveBeenCalled()
	expect(renderedConnectOauth()).toEqual({
		ok: true,
		provider: null,
		integration: null,
		redirectUri: 'https://example.com/connect/oauth',
	})
})
