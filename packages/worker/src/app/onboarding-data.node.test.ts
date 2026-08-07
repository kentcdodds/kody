import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
	buildIntroEmailLookupPrompt,
	buildIntroEmailPrompt,
	buildMcpServerUrl,
	buildMemoryPrompt,
	buildOnboardingSetupPrompt,
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'

test('onboarding data builds the MCP URL and derives incomplete setup from verification plus grants', async () => {
	expect(
		buildMcpServerUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://preview.example/account',
		}),
	).toBe('https://preview.example/mcp')

	// Discovery prompt must identify the deployment origin so agents know
	// which Kody instance the user is evaluating.
	expect(
		buildDiscoveryPrompt({
			env: {},
			requestUrl: 'https://preview.example/onboarding',
		}),
	).toContain('https://preview.example')

	// After the welcome reply, the lookup prompt is the explicit second paste.
	expect(buildIntroEmailLookupPrompt().toLowerCase()).toContain('look up')

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
		introEmailPrompt: buildIntroEmailPrompt(),
		introEmailLookupPrompt: buildIntroEmailLookupPrompt(),
		memoryPrompt: buildMemoryPrompt(),
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		checklist: null,
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
		introEmailPrompt: buildIntroEmailPrompt(),
		introEmailLookupPrompt: buildIntroEmailLookupPrompt(),
		memoryPrompt: buildMemoryPrompt(),
		hasMcpClient: false,
		emailVerified: true,
		needsOnboarding: true,
		featuredListings: [],
		checklist: null,
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
		// First-win prompts need a verified email (they send/store real data).
		introEmailPrompt: '',
		introEmailLookupPrompt: '',
		memoryPrompt: '',
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
