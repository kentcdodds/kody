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

test('kody_official_guide returns markdown when fetch succeeds', async () => {
	const originalFetch = globalThis.fetch
	const url = buildKodyOfficialGuideUrlForTest('oauth')
	expect(url).toMatch(/\/oauth\.md$/)
	globalThis.fetch = (async (input) => {
		expect(String(input)).toBe(url)
		return new Response('# Hello\n\nbody', { status: 200 })
	}) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'oauth' },
			ctx,
		)
		expect(result.title).toBe('OAuth guide (standard path)')
		expect(result.body).toBe('# Hello\n\nbody')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('kody_official_guide throws on HTTP error', async () => {
	const originalFetch = globalThis.fetch
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
})

test('kody_official_guide wraps network failures', async () => {
	const originalFetch = globalThis.fetch
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

test('kody_official_guide distinguishes PKCE and server-side helpers in repo-shaped body', async () => {
	const originalFetch = globalThis.fetch
	const body = [
		'# Generated UI OAuth guide',
		'exchangePkceOAuthCode({ tokenUrl, code, redirectUri, clientId, codeVerifier, extraParams? })',
		'exchangeOAuthCodeWithSecrets({ tokenUrl, code, redirectUri, clientId, clientSecretSecretName, scope?, extraParams? })',
		'Choosing the exchange helper',
		'prefer `exchangePkceOAuthCode(...)` when the provider supports PKCE',
		'`exchangeOAuthCodeWithSecrets(...)`',
		'run server-side',
	].join('\n')
	globalThis.fetch = (async () =>
		new Response(body, { status: 200 })) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'generated_ui_oauth' },
			ctx,
		)
		expect(result.body).toContain(
			'exchangePkceOAuthCode({ tokenUrl, code, redirectUri, clientId, codeVerifier, extraParams? })',
		)
		expect(result.body).toContain('Choosing the exchange helper')
	} finally {
		globalThis.fetch = originalFetch
	}
})
