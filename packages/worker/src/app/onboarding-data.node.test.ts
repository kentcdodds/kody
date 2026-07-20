import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'

test('onboarding setup prompt steers agents to fork trusted community packages before creating', () => {
	const prompt = buildOnboardingSetupPrompt()
	expect(prompt).toContain('community_search')
	expect(prompt).toContain('trusted community package')
	expect(prompt).toContain('community_fork')
	expect(prompt).toContain(
		'only create a new package if nothing suitable exists',
	)
	expect(prompt).not.toContain('then package things up once they work')
})

test('onboarding data builds the MCP URL and derives incomplete setup from verification plus grants', async () => {
	expect(
		buildMcpServerUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://preview.example/account',
		}),
	).toBe('https://preview.example/mcp')

	expect(
		buildDiscoveryPrompt({
			env: {},
			requestUrl: 'https://heykody.dev/onboarding',
		}),
	).toContain(
		"I'm deciding whether Kody (https://heykody.dev) would be useful for me.",
	)

	expect(
		loadPublicOnboardingData({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			requestUrl: 'https://heykody.dev/onboarding',
		}),
	).toEqual({
		ok: true,
		loggedIn: false,
		mcpServerUrl: 'https://heykody.dev/mcp',
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			requestUrl: 'https://heykody.dev/onboarding',
		}),
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
	})

	const withoutClient = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({ items: [] })),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		emailVerified: true,
	})
	expect(withoutClient).toEqual({
		ok: true,
		loggedIn: true,
		mcpServerUrl: 'https://heykody.dev/mcp',
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env: {},
			requestUrl: 'https://heykody.dev/onboarding',
		}),
		hasMcpClient: false,
		emailVerified: true,
		needsOnboarding: true,
		featuredListings: [],
	})

	const withClient = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({
					items: [{ id: 'grant-1' }],
				})),
			},
		},
		requestUrl: 'http://localhost:3742/onboarding',
		stableUserId: 'user-1',
		emailVerified: true,
	})
	expect(withClient).toMatchObject({
		hasMcpClient: true,
		emailVerified: true,
		needsOnboarding: false,
		mcpServerUrl: 'http://localhost:3742/mcp',
	})

	const unverifiedWithGrant = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({
					items: [{ id: 'grant-1' }],
				})),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		emailVerified: false,
	})
	expect(unverifiedWithGrant).toMatchObject({
		hasMcpClient: true,
		emailVerified: false,
		needsOnboarding: true,
		mcpServerUrl: '',
		setupPrompt: '',
		// Discovery needs no verified email or MCP host, so it is never gated.
		discoveryPrompt: buildDiscoveryPrompt({
			env: {},
			requestUrl: 'https://heykody.dev/onboarding',
		}),
	})

	const whenProviderListingFails = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => {
					throw new Error('provider unavailable')
				}),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		emailVerified: true,
	})
	expect(whenProviderListingFails.hasMcpClient).toBe(false)
	expect(whenProviderListingFails.needsOnboarding).toBe(true)
})
