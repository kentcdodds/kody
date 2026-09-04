import { expect, test } from 'vitest'
import { emptyOnboardingSessionMilestones } from '#universal/onboarding-process.ts'
import {
	clearOnboardingPayloadCache,
	fetchOnboardingPayload,
	type OnboardingPayload,
} from './onboarding-payload.ts'

const payload = {
	ok: true,
	loggedIn: false,
	username: null,
	mcpServerUrl: 'https://example.com/mcp',
	setupPrompt: '',
	discoveryPrompt: '',
	persistPrompt: '',
	milestones: emptyOnboardingSessionMilestones,
	hasMcpClient: false,
	emailVerified: false,
	needsOnboarding: true,
	featuredListings: [],
	featuredMcpServers: [],
	customMcpServers: [],
	persistedPackageKodyId: null,
	checklist: null,
} satisfies OnboardingPayload

test('onboarding payload fetch coalesces in flight and reuses the warm cache', async () => {
	clearOnboardingPayloadCache()
	const originalFetch = globalThis.fetch
	let resolveResponse!: (value: Response) => void
	const calls: Array<string> = []
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(String(input))
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
	}) as typeof fetch

	try {
		const first = fetchOnboardingPayload()
		const second = fetchOnboardingPayload()
		expect(calls).toEqual(['/onboarding.json'])
		resolveResponse(Response.json(payload))
		await expect(first).resolves.toEqual(payload)
		await expect(second).resolves.toEqual(payload)
		expect(calls).toHaveLength(1)

		await expect(fetchOnboardingPayload()).resolves.toEqual(payload)
		expect(calls).toHaveLength(1)

		clearOnboardingPayloadCache()
		const third = fetchOnboardingPayload()
		expect(calls).toHaveLength(2)
		resolveResponse(Response.json(payload))
		await third
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
})
