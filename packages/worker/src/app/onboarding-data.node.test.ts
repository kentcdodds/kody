import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
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

	// The whole first win is one paste, and it routes through the guide rather
	// than restating the loop. "Ask the connected Kody server" is deliberate:
	// some hosts read "Hey Kody" as impersonation and skip MCP tools.
	const firstWinPrompt = buildFirstWinPrompt({
		env: {},
		requestUrl: 'https://preview.example/onboarding',
	})
	expect(firstWinPrompt).toContain('https://preview.example/guides/first-win')
	expect(firstWinPrompt.toLowerCase()).toContain('connected kody server')
	expect(firstWinPrompt.toLowerCase()).not.toContain('hey kody')
	// The agent must hand back to the person instead of busy-waiting.
	expect(firstWinPrompt.toLowerCase()).toContain('do not poll')

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
		firstWinPrompt: buildFirstWinPrompt({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			requestUrl: 'https://heykody.dev/onboarding',
		}),
		hasSentWelcomeEmail: false,
		welcomeEmail: null,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		builtInProviders: [],
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
		firstWinPrompt: buildFirstWinPrompt({
			env: {},
			requestUrl: 'https://heykody.dev/onboarding',
		}),
		hasSentWelcomeEmail: false,
		welcomeEmail: null,
		hasMcpClient: false,
		emailVerified: true,
		needsOnboarding: true,
		featuredListings: [],
		builtInProviders: [],
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
		welcomeEmail: {
			subject: 'Welcome to Kody — reply to introduce yourself',
			fromAddress: 'kody@heykody.app',
		},
	})
	expect(withClient).toMatchObject({
		hasMcpClient: true,
		emailVerified: true,
		needsOnboarding: false,
		mcpServerUrl: 'http://localhost:3742/mcp',
		// Passed straight through so the Reply sub-step can name the real
		// subject and sender instead of the copy the prompt suggests.
		welcomeEmail: {
			subject: 'Welcome to Kody — reply to introduce yourself',
			fromAddress: 'kody@heykody.app',
		},
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
		// The first-win prompt needs a verified email (it sends real mail).
		firstWinPrompt: '',
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
