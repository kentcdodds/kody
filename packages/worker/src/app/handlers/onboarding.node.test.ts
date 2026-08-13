import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
	loadOnboardingBuiltInProviders,
	loadWelcomeEmail,
} from '#app/handlers/onboarding.ts'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildOnboardingSetupPrompt,
} from '#app/onboarding-data.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listOwnerEmailMessages: vi.fn(),
	searchOwnerEmailMessages: vi.fn(),
	listTopPlatformAppsByUse: vi.fn(),
	listJoinedIntegrations: vi.fn(),
	buildPlatformOauthAppLogoPath: vi.fn(),
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
}))

vi.mock('#worker/integrations/platform-app-logo.ts', () => ({
	buildPlatformOauthAppLogoPath: (...args: Array<unknown>) =>
		mockModule.buildPlatformOauthAppLogoPath(...args),
}))

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
