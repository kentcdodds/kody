import { expect, test } from 'vitest'
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
	hasAccessWin: false,
	hasSecondMcpClient: false,
	hasMcpClient: false,
	emailVerified: false,
	needsOnboarding: true,
	featuredListings: [],
	featuredMcpServers: [],
	customMcpServers: [],
	persistedPackageKodyId: null,
	accessWinMemorySubject: null,
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

test('fresh fetch skips the warm cache so progress polls see live access wins', async () => {
	clearOnboardingPayloadCache()
	const originalFetch = globalThis.fetch
	const calls: Array<string> = []
	const stale = { ...payload, hasMcpClient: false }
	const live = { ...payload, hasMcpClient: true }
	const bodies = [stale, live]
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(String(input))
		const body = bodies.shift() ?? live
		return Promise.resolve(Response.json(body))
	}) as typeof fetch

	try {
		await expect(fetchOnboardingPayload()).resolves.toEqual(stale)
		await expect(fetchOnboardingPayload()).resolves.toEqual(stale)
		expect(calls).toHaveLength(1)
		await expect(
			fetchOnboardingPayload(undefined, { fresh: true }),
		).resolves.toEqual(live)
		expect(calls).toHaveLength(2)
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
})

test('clearing the cache aborts the in-flight request so it cannot rewrite progress', async () => {
	clearOnboardingPayloadCache()
	const originalFetch = globalThis.fetch
	const calls: Array<string> = []
	const controllers: Array<AbortController> = []
	let resolveStale!: (value: Response) => void
	let resolveFresh!: (value: Response) => void
	const stale = { ...payload, hasMcpClient: false }
	const live = { ...payload, hasMcpClient: true }
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(String(input))
		if (init?.signal instanceof AbortSignal) {
			const controller = new AbortController()
			init.signal.addEventListener(
				'abort',
				() => {
					controller.abort()
				},
				{ once: true },
			)
			controllers.push(controller)
		}
		return new Promise<Response>((resolve, reject) => {
			if (calls.length === 1) {
				resolveStale = resolve
				controllers.at(-1)?.signal.addEventListener(
					'abort',
					() => {
						reject(new DOMException('Aborted', 'AbortError'))
					},
					{ once: true },
				)
				return
			}
			resolveFresh = resolve
		})
	}) as typeof fetch

	try {
		const first = fetchOnboardingPayload()
		expect(calls).toHaveLength(1)
		clearOnboardingPayloadCache()
		await expect(first).rejects.toMatchObject({ name: 'AbortError' })

		const second = fetchOnboardingPayload()
		expect(calls).toHaveLength(2)
		resolveStale(Response.json(stale))
		resolveFresh(Response.json(live))
		await expect(second).resolves.toEqual(live)
		await expect(fetchOnboardingPayload()).resolves.toEqual(live)
		expect(calls).toHaveLength(2)
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
})
