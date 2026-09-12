import { expect, test } from 'vitest'
import { clearOnboardingPayloadCache } from './onboarding-payload.ts'
import { homeRouteLoader } from './home.tsx'
import { routes } from '#universal/routes.ts'

test('homeRouteLoader fail-opens when the hero JSON fetch throws', async () => {
	clearOnboardingPayloadCache()
	const originalFetch = globalThis.fetch
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input)
		if (url === routes.landingHeroVideosApi.href()) {
			return Promise.reject(new TypeError('Failed to fetch'))
		}
		return Promise.resolve(
			Response.json({
				ok: true,
				loggedIn: false,
				username: null,
				mcpServerUrl: 'https://example.com/mcp',
				setupPrompt: '',
				discoveryPrompt: '',
				persistPrompt: '',
				hasAccessWin: false,
				hasSecondMcpClient: false,
				hasMcpClient: false,
				connectedAgents: [],
				secondAgentStandardGift: {
					received: false,
					active: false,
					status: 'none',
					expiresAt: null,
					grantedAt: null,
				},
				emailVerified: false,
				needsOnboarding: true,
				featuredListings: [],
				featuredMcpServers: [],
				customMcpServers: [],
				persistedPackageName: null,
				accessWinMemorySubject: null,
				checklist: null,
			}),
		)
	}) as typeof fetch

	try {
		const result = await homeRouteLoader(
			new URL('http://localhost/'),
			new AbortController().signal,
		)
		expect(result.landingHeroVideos).toEqual([])
		expect(result.onboarding).toMatchObject({ ok: true, loggedIn: false })
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
})

test('homeRouteLoader rethrows when the hero JSON fetch is aborted', async () => {
	clearOnboardingPayloadCache()
	const originalFetch = globalThis.fetch
	const controller = new AbortController()
	controller.abort()
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.signal?.aborted) {
			return Promise.reject(new DOMException('Aborted', 'AbortError'))
		}
		return Promise.resolve(Response.json({ ok: true }))
	}) as typeof fetch

	try {
		await expect(
			homeRouteLoader(new URL('http://localhost/'), controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' })
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
})
