import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
	loadOnboardingCustomMcpServers,
	loadOnboardingFeaturedMcpServers,
	loadPersistedPackageKodyId,
} from '#app/handlers/onboarding.ts'
import { type OnboardingLoaderData } from '#universal/loader-data.ts'

function expectDisconnectedFeaturedCatalog(
	servers: OnboardingLoaderData['featuredMcpServers'],
) {
	expect(servers.map((server) => server.id)).toContain('notion')
	expect(
		servers.every((server) => !server.connected && server.serverId === null),
	).toBe(true)
}

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listMcpServerSettings: vi.fn(),
	loadMcpClientHubSnapshotOrNull: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async () => new Response('ok')),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	listFeaturedCommunityListingsWithAggregates: vi.fn(async () => []),
	getCommunityListingWithAggregates: vi.fn(async () => null),
	getCommunityListingsByIds: vi.fn(async () => []),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/capabilities/mcp-servers/shared.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#mcp/capabilities/mcp-servers/shared.ts')
		>()
	return {
		...actual,
		loadMcpClientHubSnapshotOrNull: (...args: Array<unknown>) =>
			mockModule.loadMcpClientHubSnapshotOrNull(...args),
	}
})

test('onboarding serves public setup content to anonymous visitors', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	setAuthSessionSecret(testCookieSecret)
	const env = { COOKIE_SECRET: testCookieSecret } as Env

	const anonymousIndexResponse = await createOnboardingHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding')),
	)
	expect(anonymousIndexResponse.status).toBe(302)
	expect(anonymousIndexResponse.headers.get('Location')).toBe(
		'https://example.com/onboarding/step-1',
	)

	const anonymousIndexPreservesSearch = await createOnboardingHandler(
		env,
	).handler(
		new RequestContext(
			new Request('https://example.com/onboarding?redirectTo=%2F'),
		),
	)
	expect(anonymousIndexPreservesSearch.status).toBe(302)
	expect(anonymousIndexPreservesSearch.headers.get('Location')).toBe(
		'https://example.com/onboarding/step-1?redirectTo=%2F',
	)

	const anonymousPageResponse = await createOnboardingHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding/step-1')),
	)
	expect(anonymousPageResponse.status).toBe(200)

	const anonymousApiResponse = await createOnboardingApiHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding.json')),
	)
	expect(anonymousApiResponse.status).toBe(200)
	expect(anonymousApiResponse.headers.get('Cache-Control')).toBe(
		'public, max-age=60, stale-while-revalidate=300',
	)
	expect(anonymousApiResponse.headers.get('Vary')).toBe('Cookie')
	const onboardingTiming =
		anonymousApiResponse.headers.get('Server-Timing') ?? ''
	expect(onboardingTiming).toContain('listings;dur=')
	expect(onboardingTiming).toContain('highlight;dur=')
	const anonymousPayload =
		(await anonymousApiResponse.json()) as OnboardingLoaderData
	expect(anonymousPayload).toMatchObject({
		ok: true,
		loggedIn: false,
		mcpServerUrl: 'https://example.com/mcp',
		needsOnboarding: true,
		persistedPackageKodyId: null,
	})
	expect(anonymousPayload.setupPrompt.length).toBeGreaterThan(0)
	expect(anonymousPayload.discoveryPrompt).toContain('https://example.com')
	expectDisconnectedFeaturedCatalog(anonymousPayload.featuredMcpServers)
})

test('onboarding API includes the authenticated package-scope username', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		username: 'u-b',
		emailVerified: false,
		mcpUser: { userId: 'user-1' },
	})
	setAuthSessionSecret(testCookieSecret)
	const env = { COOKIE_SECRET: testCookieSecret } as Env

	const response = await createOnboardingApiHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding.json')),
	)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		loggedIn: true,
		username: 'u-b',
		persistedPackageKodyId: null,
	})
})

test('onboarding featured MCP servers overlay Notion and Linear connection state', async () => {
	const env = {} as Env
	mockModule.listMcpServerSettings.mockResolvedValue([
		{
			id: 'srv-linear',
			name: 'linear',
			url: 'https://mcp.linear.app/mcp',
			enabled: true,
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
			usageMode: 'any',
			allowedPackageIds: [],
		},
	])
	mockModule.loadMcpClientHubSnapshotOrNull.mockResolvedValue({
		servers: [
			{
				serverId: 'srv-linear',
				state: 'ready',
				authUrl: null,
				error: null,
				tools: [{ name: 'list_issues' }],
			},
		],
	})

	const anonymous = await loadOnboardingFeaturedMcpServers(env)
	expectDisconnectedFeaturedCatalog(anonymous)
	expect(mockModule.listMcpServerSettings).not.toHaveBeenCalled()

	const signedIn = await loadOnboardingFeaturedMcpServers(env, 'viewer-1')
	expect(signedIn[0]).toMatchObject({
		id: 'notion',
		connected: false,
		serverId: null,
	})
	expect(signedIn[1]).toMatchObject({
		id: 'linear',
		connected: true,
		serverId: 'srv-linear',
		state: 'ready',
	})
	expect(mockModule.listMcpServerSettings).toHaveBeenCalledWith({
		env,
		userId: 'viewer-1',
	})

	mockModule.listMcpServerSettings.mockRejectedValue(new Error('d1 blip'))
	const fallback = await loadOnboardingFeaturedMcpServers(env, 'viewer-1')
	expectDisconnectedFeaturedCatalog(fallback)
})

test('onboarding custom MCP servers exclude featured remotes', async () => {
	const env = {} as Env
	mockModule.listMcpServerSettings.mockResolvedValue([
		{
			id: 'srv-linear',
			name: 'linear',
			url: 'https://mcp.linear.app/mcp',
			enabled: true,
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
			usageMode: 'any',
			allowedPackageIds: [],
		},
		{
			id: 'srv-acme',
			name: 'acme',
			url: 'https://mcp.acme.example/mcp',
			enabled: true,
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
			usageMode: 'any',
			allowedPackageIds: [],
		},
	])
	mockModule.loadMcpClientHubSnapshotOrNull.mockResolvedValue({
		servers: [
			{
				serverId: 'srv-acme',
				state: 'ready',
				authUrl: null,
				error: null,
				tools: [{ name: 'ping' }],
			},
		],
	})

	await expect(loadOnboardingCustomMcpServers(env)).resolves.toEqual([])
	await expect(
		loadOnboardingCustomMcpServers(env, 'viewer-1'),
	).resolves.toEqual([
		{
			id: 'srv-acme',
			name: 'acme',
			url: 'https://mcp.acme.example/mcp',
			connected: true,
			authUrl: null,
			state: 'ready',
			error: null,
		},
	])
})

test('invalid onboarding agent or service paths redirect to that step', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	setAuthSessionSecret(testCookieSecret)
	const env = { COOKIE_SECRET: testCookieSecret } as Env
	const handler = createOnboardingHandler(env)

	const badAgent = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding/step-1/nope'),
		),
	)
	expect(badAgent.status).toBe(302)
	expect(
		new URL(badAgent.headers.get('Location') ?? '', 'https://example.com')
			.pathname,
	).toBe('/onboarding/step-1')

	const badService = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding/step-2/nope?redirectTo=%2F'),
		),
	)
	expect(badService.status).toBe(302)
	expect(
		new URL(badService.headers.get('Location') ?? '', 'https://example.com')
			.pathname,
	).toBe('/onboarding/step-2')
	expect(
		new URL(badService.headers.get('Location') ?? '', 'https://example.com')
			.search,
	).toBe('?redirectTo=%2F')

	const notListed = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding/step-2/not-listed'),
		),
	)
	expect(notListed.status).toBe(302)
	expect(
		new URL(notListed.headers.get('Location') ?? '', 'https://example.com')
			.pathname,
	).toBe('/onboarding/step-2')

	const step2 = await handler.handler(
		new RequestContext(new Request('https://example.com/onboarding/step-2')),
	)
	expect(step2.status).toBe(200)

	const step3 = await handler.handler(
		new RequestContext(new Request('https://example.com/onboarding/step-3')),
	)
	expect(step3.status).toBe(200)

	const step3Agent = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding/step-3/claude-code'),
		),
	)
	expect(step3Agent.status).toBe(200)

	const badSecondAgent = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding/step-3/nope'),
		),
	)
	expect(badSecondAgent.status).toBe(302)
	expect(
		new URL(badSecondAgent.headers.get('Location') ?? '', 'https://example.com')
			.pathname,
	).toBe('/onboarding/step-3')
})

test('onboarding persist next-steps use the newest saved-package kody id', async () => {
	const env = { APP_DB: {} } as Env

	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{ kodyId: 'morning-digest' },
		{ kodyId: 'older-package' },
	])
	await expect(loadPersistedPackageKodyId(env, 'user-1')).resolves.toBe(
		'morning-digest',
	)
	expect(mockModule.listSavedPackagesByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		{ userId: 'user-1' },
	)

	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	await expect(loadPersistedPackageKodyId(env, 'user-1')).resolves.toBeNull()

	mockModule.listSavedPackagesByUserId.mockRejectedValue(new Error('d1 blip'))
	await expect(loadPersistedPackageKodyId(env, 'user-1')).resolves.toBeNull()

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		username: 'u-b',
		emailVerified: true,
		mcpUser: { userId: 'user-1' },
	})
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{ kodyId: 'morning-digest' },
	])
	mockModule.listMcpServerSettings.mockResolvedValue([])

	const response = await createOnboardingApiHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding.json')),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		loggedIn: true,
		username: 'u-b',
		persistedPackageKodyId: 'morning-digest',
	})
})
