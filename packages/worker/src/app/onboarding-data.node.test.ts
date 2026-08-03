import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
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
	).toBe(
		"I'm deciding whether Kody (https://preview.example) would be useful for me. Read https://github.com/kentcdodds/kody/blob/main/docs/use/what-can-kody-do.md and follow its links for anything you need more detail on. Interview me conversationally about the tools I use, recurring chores I do by hand, and automations I've wished for. Ask at most 2 short questions per message, then wait for my answer. Keep each message under roughly 120 words until your final recommendations. Finish with 3–5 specific things Kody could do for me, ranked by payoff versus setup effort, each with a concrete first step. Don't set anything up yet — this works before I have an account. After the ranked list, finish with a short \"Next steps if you want to connect me to Kody\" section. Point me to https://preview.example/onboarding and explain that the only setup is adding Kody as an MCP server there — there is no CLI to install.",
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

test('the documented Try it prompt matches the production discovery prompt', async () => {
	const documentation = await readFile(
		new URL('../../../../docs/use/what-can-kody-do.md', import.meta.url),
		'utf8',
	)
	const tryItSection = documentation
		.split(/^## /m)
		.find((section) => section.startsWith('Try it\n'))
	expect(tryItSection, 'docs must include a Try it section').toBeDefined()

	const documentedPrompt = tryItSection
		?.split('\n')
		.filter((line) => line.startsWith('>'))
		.map((line) => line.replace(/^>\s?/, ''))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
	expect(documentedPrompt).toBe(
		buildDiscoveryPrompt({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			requestUrl: 'https://heykody.dev/onboarding',
		}),
	)
})
