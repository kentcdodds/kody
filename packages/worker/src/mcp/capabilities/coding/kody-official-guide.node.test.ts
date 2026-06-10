import { expect, test } from 'vitest'
import {
	buildKodyOfficialGuideUrlForTest,
	kodyOfficialGuideCapability,
} from './kody-official-guide.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

test('kody_official_guide fetches markdown and surfaces fetch failures', async () => {
	const originalFetch = globalThis.fetch
	const url = buildKodyOfficialGuideUrlForTest('package_subscriptions')
	globalThis.fetch = (async (input) => {
		expect(String(input)).toBe(url)
		return new Response('# Hello\n\nbody', { status: 200 })
	}) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'package_subscriptions' },
			ctx,
		)
		expect(result.body).toBe('# Hello\n\nbody')
		expect(result.title.length).toBeGreaterThan(0)
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = (async () => {
		return new Response('missing', { status: 404 })
	}) as typeof fetch
	try {
		await expect(
			kodyOfficialGuideCapability.handler({ guide: 'connect_secret' }, ctx),
		).rejects.toThrow(/Kody guide fetch failed: HTTP 404/)
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = (async () => {
		throw new Error('network down')
	}) as typeof fetch
	try {
		await expect(
			kodyOfficialGuideCapability.handler({ guide: 'generated_ui_oauth' }, ctx),
		).rejects.toThrow(/Kody guide fetch failed: network down/)
	} finally {
		globalThis.fetch = originalFetch
	}
})
