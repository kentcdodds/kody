import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
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

test('kody_official_guide returns markdown when fetch succeeds', async () => {
	const originalFetch = globalThis.fetch
	const url = buildKodyOfficialGuideUrlForTest('integration_bootstrap')
	expect(url).toMatch(/\/integration-bootstrap\.md$/)
	globalThis.fetch = (async (input) => {
		expect(String(input)).toBe(url)
		return new Response('# Hello\n\nbody', { status: 200 })
	}) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'integration_bootstrap' },
			ctx,
		)
		expect(result.title).toBeTruthy()
		expect(result.body).toBe('# Hello\n\nbody')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('kody_official_guide includes the voice package app starter', () => {
	const url = buildKodyOfficialGuideUrlForTest('voice_package_app')
	expect(url).toMatch(/\/voice-package-app\.md$/)
	expect(kodyOfficialGuideCapability.description).toContain('voice_package_app')
	expect(kodyOfficialGuideCapability.keywords).toEqual(
		expect.arrayContaining(['cloudflare voice', 'thinking sound']),
	)
})

test('voice package app example has a saveable manifest and accessible UI hooks', async () => {
	const packageJson = await readFile(
		'docs/examples/voice-call-app/package.json',
		'utf8',
	)
	const manifest = parseAuthoredPackageJson({ content: packageJson })
	expect(manifest.kody.id).toBe('voice-call-app')
	expect(manifest.kody.app?.entry).toBe('app.ts')

	const appSource = await readFile(
		'docs/examples/voice-call-app/app.ts',
		'utf8',
	)
	expect(appSource).toContain('aria-live="polite"')
	expect(appSource).toContain("import('kody:runtime')")
	expect(appSource).toContain('startThinkingSound')
	expect(appSource).not.toContain('agent_turn')
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
