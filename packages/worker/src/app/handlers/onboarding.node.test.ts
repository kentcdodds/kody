import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
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
