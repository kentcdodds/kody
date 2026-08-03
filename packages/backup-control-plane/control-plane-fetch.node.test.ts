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
	{ method: 'GET', path: '/mailbox-pre-drop-status?id=demo' },
	{ method: 'POST', path: '/actions/run-backup' },
	{ method: 'POST', path: '/actions/mailbox-pre-drop-backup' },
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

test('authenticated pre-drop action creates only server-generated workflow params', async () => {
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
	let created: { id: string; params: Record<string, unknown> } | undefined
	env.MAILBOX_PRE_DROP_BACKUP_WORKFLOW = {
		async create(input: { id: string; params: Record<string, unknown> }) {
			created = input
		},
	} as unknown as Workflow
	const response = await handleControlPlaneFetch(
		new Request(
			'https://backup.example/actions/mailbox-pre-drop-backup?sqlSha256=caller-value',
			{
				method: 'POST',
				headers: {
					'cf-access-jwt-assertion': jwt,
					'sec-fetch-site': 'same-origin',
				},
				body: 'manifestKey=caller-value',
			},
		),
		env,
		async () => Response.json(jwks),
	)
	assert.equal(response.status, 200)
	assert.ok(created)
	assert.deepEqual(Object.keys(created.params).sort(), [
		'nonce',
		'requestId',
		'requestedAt',
	])
	assert.equal(
		created.id,
		`mailbox-pre-drop-${String(created.params.requestId)}`,
	)
	assert.doesNotMatch(JSON.stringify(created), /caller-value/u)
})

test('authenticated pre-drop action stays disabled when either backup gate is false', async () => {
	resetAccessJwksCacheForTests()
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const { kid, jwks, sign } = rsaJwksAndSigner()
	const baseEnv = environment()
	const now = Math.floor(Date.now() / 1000)
	const jwt = sign(
		{ alg: 'RS256', kid },
		{
			iss: `https://${baseEnv.ACCESS_TEAM_DOMAIN}`,
			aud: baseEnv.ACCESS_APP_AUD,
			email: baseEnv.ACCESS_ALLOWED_EMAIL,
			iat: now - 5,
			exp: now + 3600,
		},
	)

	for (const disabledGate of [
		'ENABLE_PRODUCTION_D1_BACKUPS',
		'BACKUP_BENCHMARK_APPROVED',
	] as const) {
		const env = environment()
		env[disabledGate] = 'false'
		const create = vi.fn(async () => undefined)
		env.MAILBOX_PRE_DROP_BACKUP_WORKFLOW = {
			create,
		} as unknown as Workflow

		const response = await handleControlPlaneFetch(
			new Request('https://backup.example/actions/mailbox-pre-drop-backup', {
				method: 'POST',
				headers: {
					'cf-access-jwt-assertion': jwt,
					'sec-fetch-site': 'same-origin',
				},
				body: '',
			}),
			env,
			async () => Response.json(jwks),
		)

		assert.equal(response.status, 400, disabledGate)
		const html = await response.text()
		assert.match(html, /Action failed/u, disabledGate)
		assert.match(html, /backup-disabled/u, disabledGate)
		assert.equal(create.mock.calls.length, 0, disabledGate)
		const log = JSON.parse(
			String(consoleError.mock.calls.at(-1)?.[0]),
		) as Record<string, unknown>
		assert.deepEqual(
			log,
			{
				event: 'ui-action-failure',
				status: 'failure',
				errorCode: 'backup-disabled',
			},
			disabledGate,
		)
	}
	assert.equal(consoleError.mock.calls.length, 2)
})
