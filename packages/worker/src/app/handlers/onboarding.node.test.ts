import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
	loadOnboardingBuiltInProviders,
	loadOnboardingFeaturedMcpServers,
	loadPersistedPackageKodyId,
	loadWelcomeEmail,
} from '#app/handlers/onboarding.ts'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
} from '#app/onboarding-data.ts'
import { listDisconnectedOnboardingFeaturedMcpServers } from '#universal/onboarding-mcp-chooser.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listOwnerEmailMessages: vi.fn(),
	searchOwnerEmailMessages: vi.fn(),
	listTopPlatformAppsByUse: vi.fn(),
	listJoinedIntegrations: vi.fn(),
	listIntegrations: vi.fn(),
	buildPlatformOauthAppLogoPath: vi.fn(),
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
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessages: (...args: Array<unknown>) =>
		mockModule.listOwnerEmailMessages(...args),
	searchOwnerEmailMessages: (...args: Array<unknown>) =>
		mockModule.searchOwnerEmailMessages(...args),
}))

vi.mock('#worker/integrations/platform-apps.ts', () => ({
	listTopPlatformAppsByUse: (...args: Array<unknown>) =>
		mockModule.listTopPlatformAppsByUse(...args),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listJoinedIntegrations: (...args: Array<unknown>) =>
		mockModule.listJoinedIntegrations(...args),
	listIntegrations: (...args: Array<unknown>) =>
		mockModule.listIntegrations(...args),
}))

vi.mock('#worker/integrations/platform-app-logo.ts', () => ({
	buildPlatformOauthAppLogoPath: (...args: Array<unknown>) =>
		mockModule.buildPlatformOauthAppLogoPath(...args),
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
		firstWinPrompt: buildFirstWinPrompt({
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
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		loggedIn: true,
		username: 'u-b',
		persistedPackageKodyId: null,
	})
})

test('the Reply sub-step names the welcome email, not merely the newest outbound', async () => {
	const env = {} as Env

	// A mailbox holding other outbound mail still surfaces the welcome message.
	mockModule.searchOwnerEmailMessages.mockResolvedValue([
		{
			subject: 'Welcome to Kody — reply to introduce yourself',
			fromAddress: 'kody@heykody.app',
		},
	])
	mockModule.listOwnerEmailMessages.mockResolvedValue([
		{ subject: 'Your morning digest', fromAddress: 'kody@heykody.app' },
	])
	await expect(loadWelcomeEmail(env, 'user-1')).resolves.toEqual({
		subject: 'Welcome to Kody — reply to introduce yourself',
		fromAddress: 'kody@heykody.app',
	})

	// Agents write their own subject, so an unmatched mailbox falls back to the
	// newest outbound message.
	mockModule.searchOwnerEmailMessages.mockResolvedValue([])
	await expect(loadWelcomeEmail(env, 'user-1')).resolves.toEqual({
		subject: 'Your morning digest',
		fromAddress: 'kody@heykody.app',
	})

	// An empty mailbox and a Mailbox blip both fail open.
	mockModule.listOwnerEmailMessages.mockResolvedValue([])
	await expect(loadWelcomeEmail(env, 'user-1')).resolves.toBeNull()
	mockModule.searchOwnerEmailMessages.mockRejectedValue(
		new Error('mailbox unavailable'),
	)
	await expect(loadWelcomeEmail(env, 'user-1')).resolves.toBeNull()
})

test('onboarding built-in providers mark connected vs not from viewer integrations', async () => {
	const env = {} as Env
	mockModule.listTopPlatformAppsByUse.mockResolvedValue([
		{ slug: 'github', label: 'GitHub', logoKey: null },
		{ slug: 'google', label: 'Google', logoKey: null },
		{ slug: 'slack', label: null, logoKey: null },
	])
	mockModule.buildPlatformOauthAppLogoPath.mockImplementation(
		(app: { slug: string }) => `/integrations/logos/${app.slug}`,
	)
	mockModule.listJoinedIntegrations.mockResolvedValue([
		{
			lane: 'platform',
			app: { slug: 'github' },
			connection: {
				name: 'github',
				platformAppSlug: 'github',
			},
		},
		{
			lane: 'user',
			app: { slug: 'custom-slack' },
			connection: {
				name: 'my-slack',
				platformAppSlug: null,
			},
		},
	])

	const anonymous = await loadOnboardingBuiltInProviders(env)
	expect(anonymous).toEqual([
		{
			slug: 'github',
			label: 'GitHub',
			logoPath: '/integrations/logos/github',
			connected: false,
			connectionName: null,
		},
		{
			slug: 'google',
			label: 'Google',
			logoPath: '/integrations/logos/google',
			connected: false,
			connectionName: null,
		},
		{
			slug: 'slack',
			label: 'slack',
			logoPath: '/integrations/logos/slack',
			connected: false,
			connectionName: null,
		},
	])
	expect(mockModule.listJoinedIntegrations).not.toHaveBeenCalled()

	const signedIn = await loadOnboardingBuiltInProviders(env, 'viewer-1')
	expect(signedIn).toEqual([
		{
			slug: 'github',
			label: 'GitHub',
			logoPath: '/integrations/logos/github',
			connected: true,
			connectionName: 'github',
		},
		{
			slug: 'google',
			label: 'Google',
			logoPath: '/integrations/logos/google',
			connected: false,
			connectionName: null,
		},
		{
			slug: 'slack',
			label: 'slack',
			logoPath: '/integrations/logos/slack',
			connected: false,
			connectionName: null,
		},
	])
	expect(mockModule.listJoinedIntegrations).toHaveBeenCalledWith({
		env,
		userId: 'viewer-1',
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.listJoinedIntegrations.mockRejectedValue(new Error('d1 blip'))
	const failedLookup = await loadOnboardingBuiltInProviders(env, 'viewer-1')
	expect(failedLookup.every((provider) => provider.connected === false)).toBe(
		true,
	)
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
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
	mockModule.listTopPlatformAppsByUse.mockResolvedValue([])
	mockModule.listJoinedIntegrations.mockResolvedValue([])
	mockModule.listIntegrations.mockResolvedValue([])
	mockModule.listMcpServerSettings.mockResolvedValue([])
	mockModule.listOwnerEmailMessages.mockResolvedValue([])
	mockModule.searchOwnerEmailMessages.mockResolvedValue([])

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
