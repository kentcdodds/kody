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
import {
	buildDiscoveryPrompt,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
} from '#app/onboarding-data.ts'
import { listDisconnectedOnboardingFeaturedMcpServers } from '#universal/onboarding-mcp-chooser.ts'

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

	const anonymousPageResponse = await createOnboardingHandler(env).handler(
		new RequestContext(new Request('https://example.com/onboarding')),
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
	// Payload shape belongs to onboarding-data; the handler just serves it.
	await expect(anonymousApiResponse.json()).resolves.toMatchObject({
		ok: true,
		loggedIn: false,
		mcpServerUrl: 'https://example.com/mcp',
		needsOnboarding: true,
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env,
			requestUrl: 'https://example.com/onboarding.json',
		}),
		persistPrompt: buildPersistFirstPackagePrompt({
			env,
			requestUrl: 'https://example.com/onboarding.json',
		}),
		featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
		persistedPackageKodyId: null,
	})
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
	expect(anonymous).toEqual(listDisconnectedOnboardingFeaturedMcpServers())
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
	await expect(
		loadOnboardingFeaturedMcpServers(env, 'viewer-1'),
	).resolves.toEqual(listDisconnectedOnboardingFeaturedMcpServers())
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
