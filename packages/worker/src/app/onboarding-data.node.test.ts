import { expect, test, vi } from 'vitest'
import {
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	loadOnboardingData,
	userHasMcpOAuthGrants,
} from '#app/onboarding-data.ts'

test('buildMcpServerUrl prefers the request origin and appends /mcp', () => {
	expect(
		buildMcpServerUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://preview.example/account',
		}),
	).toBe('https://preview.example/mcp')
})

test('userHasMcpOAuthGrants is false without a provider or grants', async () => {
	expect(await userHasMcpOAuthGrants({}, 'user-1')).toBe(false)
	expect(
		await userHasMcpOAuthGrants(
			{
				OAUTH_PROVIDER: {
					listUserGrants: vi.fn(async () => ({ items: [] })),
				},
			},
			'user-1',
		),
	).toBe(false)
})

test('userHasMcpOAuthGrants is true when the first page has a grant', async () => {
	const listUserGrants = vi.fn(async () => ({
		items: [{ id: 'grant-1', clientId: 'client-1' }],
	}))
	expect(
		await userHasMcpOAuthGrants(
			{ OAUTH_PROVIDER: { listUserGrants } },
			'user-1',
		),
	).toBe(true)
	expect(listUserGrants).toHaveBeenCalledWith('user-1')
})

test('userHasMcpOAuthGrants treats listing failures as no grants', async () => {
	expect(
		await userHasMcpOAuthGrants(
			{
				OAUTH_PROVIDER: {
					listUserGrants: vi.fn(async () => {
						throw new Error('provider unavailable')
					}),
				},
			},
			'user-1',
		),
	).toBe(false)
})

test('loadOnboardingData returns the MCP URL, setup prompt, and needs flag', async () => {
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
	expect(withClient.needsOnboarding).toBe(false)
	expect(withClient.hasMcpClient).toBe(true)
	expect(withClient.mcpServerUrl).toBe('http://localhost:3742/mcp')
})
