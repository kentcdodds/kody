import { expect, test, vi } from 'vitest'
import {
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	loadOnboardingData,
} from '#app/onboarding-data.ts'

test('onboarding data builds the MCP URL and derives MCP-client status from OAuth grants', async () => {
	expect(
		buildMcpServerUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://preview.example/account',
		}),
	).toBe('https://preview.example/mcp')

	const withoutClient = await loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: vi.fn(async () => ({ items: [] })),
			},
		},
		requestUrl: 'https://heykody.dev/onboarding',
		stableUserId: 'user-1',
	})
	expect(withoutClient).toEqual({
		ok: true,
		mcpServerUrl: 'https://heykody.dev/mcp',
		setupPrompt: buildOnboardingSetupPrompt(),
		hasMcpClient: false,
		needsOnboarding: true,
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
	})
	expect(withClient).toMatchObject({
		hasMcpClient: true,
		needsOnboarding: false,
		mcpServerUrl: 'http://localhost:3742/mcp',
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
	})
	expect(whenProviderListingFails.hasMcpClient).toBe(false)
	expect(whenProviderListingFails.needsOnboarding).toBe(true)
})
