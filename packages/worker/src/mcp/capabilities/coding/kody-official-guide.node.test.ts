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

test('kody_official_guide description surfaces integration bootstrap flow', () => {
	expect(kodyOfficialGuideCapability.description).toContain(
		'Prefer this capability plus `search` results',
	)
	expect(kodyOfficialGuideCapability.description).toContain(
		'guide: "integration_bootstrap"',
	)
	expect(kodyOfficialGuideCapability.description).toContain(
		'saved `integration` / `secret` entities',
	)
	expect(kodyOfficialGuideCapability.description).toContain(
		'cheap authenticated smoke test before building',
	)
	expect(kodyOfficialGuideCapability.description).not.toContain(
		'Available guides (order matters',
	)
})

test('kody_official_guide returns markdown when fetch succeeds', async () => {
	const originalFetch = globalThis.fetch
	const url = buildKodyOfficialGuideUrlForTest('package_subscriptions')
	expect(url).toMatch(/\/package-subscriptions\.md$/)
	globalThis.fetch = (async (input) => {
		expect(String(input)).toBe(url)
		return new Response('# Hello\n\nbody', { status: 200 })
	}) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'package_subscriptions' },
			ctx,
		)
		expect(result.title).toBeTruthy()
		expect(result.body).toBe('# Hello\n\nbody')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('kody_official_guide metadata routes package authoring discovery', () => {
	expect(kodyOfficialGuideCapability.description).toContain('package_authoring')
	expect(kodyOfficialGuideCapability.description).toContain(
		'The `guide` input describes each available guide',
	)
	expect(kodyOfficialGuideCapability.description).not.toContain(
		'README.md Intent',
	)
	expect(kodyOfficialGuideCapability.keywords).toEqual(
		expect.arrayContaining(['readme intent', 'intent section']),
	)
})

test('kody_official_guide surfaces fetch failures', async () => {
	const originalFetch = globalThis.fetch
	try {
		await expect(
			(async () => {
				globalThis.fetch = (async () => {
					return new Response('missing', { status: 404 })
				}) as typeof fetch
				await kodyOfficialGuideCapability.handler(
					{ guide: 'connect_secret' },
					ctx,
				)
			})(),
		).rejects.toThrow(/Kody guide fetch failed: HTTP 404/)
		await expect(
			(async () => {
				globalThis.fetch = (async () => {
					throw new Error('network down')
				}) as typeof fetch
				await kodyOfficialGuideCapability.handler(
					{ guide: 'generated_ui_oauth' },
					ctx,
				)
			})(),
		).rejects.toThrow(/Kody guide fetch failed: network down/)
	} finally {
		globalThis.fetch = originalFetch
	}
})
