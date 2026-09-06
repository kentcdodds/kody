import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildPersistFirstPackagePrompt,
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

	// Discovery and first-win prompts must identify the deployment origin so
	// agents know which Kody instance the user is evaluating.
	expect(
		buildDiscoveryPrompt({
			env: {},
			requestUrl: 'https://preview.example/onboarding',
		}),
	).toContain('https://preview.example')
	expect(
		buildFirstWinPrompt({
			env: {},
			requestUrl: 'https://preview.example/onboarding',
		}),
	).toContain('https://preview.example/guides/first-win')
	expect(
		buildPersistFirstPackagePrompt({
			env: {},
			requestUrl: 'https://preview.example/onboarding',
		}),
	).toContain('https://preview.example/guides/quick-example')

	const publicData = loadPublicOnboardingData({
		env: { APP_BASE_URL: 'https://heykody.dev' },
		requestUrl: 'https://heykody.dev/onboarding',
	})
	expect(publicData).toMatchObject({
		ok: true,
		loggedIn: false,
		username: null,
		mcpServerUrl: 'https://heykody.dev/mcp',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		customMcpServers: [],
		persistedPackageKodyId: null,
		checklist: null,
	})
	expect(publicData.setupPrompt.length).toBeGreaterThan(0)
	expect(publicData.discoveryPrompt).toContain('https://heykody.dev')
	expect(publicData.persistPrompt).toContain('https://heykody.dev')
	expect(
		publicData.featuredMcpServers.every(
			(server) => !server.connected && server.serverId === null,
		),
	).toBe(true)

	const withoutClient = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({ items: [] })),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		username: 'u-b',
		emailVerified: true,
	})
	expect(withoutClient).toMatchObject({
		ok: true,
		loggedIn: true,
		username: 'u-b',
		mcpServerUrl: 'https://heykody.dev/mcp',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		emailVerified: true,
		needsOnboarding: true,
		featuredListings: [],
		customMcpServers: [],
		persistedPackageKodyId: null,
		checklist: null,
	})
	expect(withoutClient.setupPrompt.length).toBeGreaterThan(0)
	expect(withoutClient.discoveryPrompt).toContain('https://heykody.dev')
	expect(
		withoutClient.featuredMcpServers.every(
			(server) => !server.connected && server.serverId === null,
		),
	).toBe(true)

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
		username: 'u-b',
		emailVerified: true,
		persistedPackageKodyId: 'morning-digest',
	})
	expect(withClient).toMatchObject({
		username: 'u-b',
		hasMcpClient: true,
		hasSecondMcpClient: false,
		emailVerified: true,
		needsOnboarding: false,
		mcpServerUrl: 'http://localhost:3742/mcp',
		// Handler-loaded persist target is passed through for Step 3 next-steps.
		persistedPackageKodyId: 'morning-digest',
	})

	const withTwoClients = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({
					items: [{ id: 'grant-1' }, { id: 'grant-2' }],
				})),
			},
		},
		requestUrl: 'http://localhost:3742/onboarding',
		stableUserId: 'user-1',
		username: 'u-b',
		emailVerified: true,
	})
	expect(withTwoClients).toMatchObject({
		hasMcpClient: true,
		hasSecondMcpClient: true,
		needsOnboarding: false,
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
		username: 'u-b',
		emailVerified: false,
		persistedPackageKodyId: 'morning-digest',
	})
	expect(unverifiedWithGrant).toMatchObject({
		hasMcpClient: true,
		emailVerified: false,
		needsOnboarding: true,
		mcpServerUrl: '',
		setupPrompt: '',
		persistPrompt: '',
		// Persist next-steps stay empty until verification.
		persistedPackageKodyId: null,
	})
	expect(unverifiedWithGrant.discoveryPrompt).toContain('https://heykody.dev')

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
		username: 'u-b',
		emailVerified: true,
	})
	expect(whenProviderListingFails.hasMcpClient).toBe(false)
	expect(whenProviderListingFails.needsOnboarding).toBe(true)

	const withCustomPersist = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({ items: [] })),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		username: 'u-b',
		emailVerified: true,
		persistContext: { connectedWorkspaceLabel: 'acme' },
	})
	expect(withCustomPersist.persistPrompt).toContain(
		'I gave Kody access to acme',
	)
	expect(withCustomPersist.customMcpServers).toEqual([])

	const withExamplePersist = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({ items: [] })),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
		username: 'u-b',
		emailVerified: true,
		persistContext: { installedExampleName: '@kody/hn-pulse' },
	})
	expect(withExamplePersist.persistPrompt).toContain(
		'I installed @kody/hn-pulse from /onboarding Step 2 Just try Kody',
	)
})
