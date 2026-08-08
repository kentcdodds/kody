import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
} from '#app/handlers/onboarding.ts'
import {
	buildDiscoveryPrompt,
	buildIntroEmailLookupPrompt,
	buildIntroEmailPrompt,
	buildOnboardingSetupPrompt,
} from '#app/onboarding-data.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
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
	await expect(anonymousApiResponse.json()).resolves.toEqual({
		ok: true,
		loggedIn: false,
		mcpServerUrl: 'https://example.com/mcp',
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env,
			requestUrl: 'https://example.com/onboarding.json',
		}),
		introEmailPrompt: buildIntroEmailPrompt(),
		introEmailLookupPrompt: buildIntroEmailLookupPrompt(),
		hasSentWelcomeEmail: false,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		checklist: null,
	})
})
