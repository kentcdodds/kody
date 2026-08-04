import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign } from 'node:crypto'

import { afterEach, test, vi } from 'vitest'

import {
	encodeJwtPartForTests,
	resetAccessJwksCacheForTests,
} from './access-auth.ts'
import { environment } from './backup-control-plane-test-support.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

function rsaJwksAndSigner() {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	})
	const jwk = publicKey.export({ format: 'jwk' })
	const kid = 'route-kid'
	return {
		kid,
		jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
		sign(header: Record<string, unknown>, payload: Record<string, unknown>) {
			const encoded = `${encodeJwtPartForTests(header)}.${encodeJwtPartForTests(payload)}`
			const signer = createSign('RSA-SHA256')
			signer.update(encoded)
			signer.end()
			const signature = signer
				.sign(privateKey)
				.toString('base64')
				.replaceAll('+', '-')
				.replaceAll('/', '_')
				.replaceAll('=', '')
			return `${encoded}.${signature}`
		},
	}
}

const routes: Array<{ method: string; path: string }> = [
	{ method: 'GET', path: '/' },
	{ method: 'GET', path: '/restore-status?id=demo' },
	{ method: 'POST', path: '/actions/run-backup' },
	{ method: 'POST', path: '/actions/seal-day' },
	{ method: 'POST', path: '/actions/run-drill' },
	{ method: 'POST', path: '/actions/restore/prepare' },
	{ method: 'POST', path: '/actions/restore/execute' },
]

test('fetch handler returns 403 without a valid Access JWT for every route', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	resetAccessJwksCacheForTests()
	const env = environment()
	for (const route of routes) {
		const response = await handleControlPlaneFetch(
			new Request(`https://backup.example${route.path}`, {
				method: route.method,
				headers:
					route.method === 'POST'
						? { 'sec-fetch-site': 'same-origin' }
						: undefined,
			}),
			env,
			async () => Response.json({ keys: [] }),
		)
		assert.equal(response.status, 403, `${route.method} ${route.path}`)
		const body = (await response.json()) as { error: string }
		assert.equal(body.error, 'forbidden')
	}
	consoleError.mockRestore()
})

test('fetch handler serves the dashboard with a valid Access JWT', async () => {
	resetAccessJwksCacheForTests()
	const { kid, jwks, sign } = rsaJwksAndSigner()
	const env = environment()
	const now = Math.floor(Date.now() / 1000)
	const jwt = sign(
		{ alg: 'RS256', kid },
		{
			iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
			aud: env.ACCESS_APP_AUD,
			email: env.ACCESS_ALLOWED_EMAIL,
			iat: now - 5,
			exp: now + 3600,
		},
	)
	const response = await handleControlPlaneFetch(
		new Request('https://backup.example/', {
			headers: { 'cf-access-jwt-assertion': jwt },
		}),
		env,
		async () => Response.json(jwks),
	)
	assert.equal(response.status, 200)
	assert.match(response.headers.get('content-type') ?? '', /text\/html/)
})
