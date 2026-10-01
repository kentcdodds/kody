import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	handleApiEdgeRequest,
	maxApiRequestBodyBytes,
	type ApiWorkerEnv,
} from './edge.ts'

const token = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`

function createEnv(
	input: { ipAllowed?: boolean; tokenAllowed?: boolean } = {},
) {
	const forwarded: Array<Request> = []
	const limited: Array<string> = []
	const limiter = (allowed: boolean) => ({
		async limit({ key }: { key: string }) {
			limited.push(key)
			return { success: allowed }
		},
	})
	const env: ApiWorkerEnv = {
		KODY_API: {
			async fetch(request: Request) {
				forwarded.push(request)
				return Response.json(
					{ ok: true },
					{ headers: { 'Set-Cookie': 'leak=1', 'Cache-Control': 'no-store' } },
				)
			},
		} as unknown as Fetcher,
		API_IP_RATE_LIMITER: limiter(input.ipAllowed ?? true),
		API_TOKEN_RATE_LIMITER: limiter(input.tokenAllowed ?? true),
		APP_COMMIT_SHA: 'abc123',
	}
	return { env, forwarded, limited }
}

test('health answers at the edge with the deployed commit', async () => {
	const { env, forwarded } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/health'),
		env,
	)
	expect(await response.json()).toEqual({ ok: true, commit: 'abc123' })
	expect(forwarded).toHaveLength(0)
})

test('forwards API routes with only safe headers and CORS on the response', async () => {
	const { env, forwarded, limited } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/call', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Cookie: 'kody_session=abc',
				'X-Kody-Internal': 'spoofed',
				'CF-Connecting-IP': '203.0.113.9',
			},
			body: JSON.stringify({ path: ['kody', 'x'], args: [] }),
		}),
		env,
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
	expect(response.headers.get('Set-Cookie')).toBeNull()
	const [request] = forwarded
	expect(request?.url).toBe('https://api.kody.test/v1/capability-proxy/call')
	expect(request?.headers.get('Authorization')).toBe(`Bearer ${token}`)
	expect(request?.headers.get('Cookie')).toBeNull()
	expect(request?.headers.get('X-Kody-Internal')).toBeNull()
	expect(await request?.json()).toEqual({ path: ['kody', 'x'], args: [] })
	expect(limited).toEqual(['ip:203.0.113.9', `token:${'a'.repeat(20)}`])
	expect(limited.join()).not.toContain('B'.repeat(43))
})

test('answers CORS preflight without forwarding', async () => {
	const { env, forwarded } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', { method: 'OPTIONS' }),
		env,
	)
	expect(response.status).toBe(204)
	expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
		'Authorization',
	)
	expect(forwarded).toHaveLength(0)
})

test('rejects unknown paths, oversize bodies, and rate-limited callers', async () => {
	const { env, forwarded } = createEnv()
	const unknown = await handleApiEdgeRequest(
		new Request('https://api.kody.test/login'),
		env,
	)
	expect(unknown.status).toBe(404)
	expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } })

	const oversize = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/memories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'x'.repeat(maxApiRequestBodyBytes + 1),
		}),
		env,
	)
	expect(oversize.status).toBe(413)
	expect(forwarded).toHaveLength(0)

	const ipLimited = createEnv({ ipAllowed: false })
	const ipResponse = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', {
			headers: { 'CF-Connecting-IP': '203.0.113.9' },
		}),
		ipLimited.env,
	)
	expect(ipResponse.status).toBe(429)
	expect(ipResponse.headers.get('Retry-After')).toBe('60')
	expect(await ipResponse.json()).toMatchObject({
		error: { code: 'rate_limited' },
	})

	const tokenLimited = createEnv({ tokenAllowed: false })
	const tokenResponse = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', {
			headers: { Authorization: `Bearer ${token}` },
		}),
		tokenLimited.env,
	)
	expect(tokenResponse.status).toBe(429)
	expect(tokenLimited.forwarded).toHaveLength(0)
})

test('reports origin failures with the error envelope', async () => {
	consoleError.mockImplementation(() => {})
	const env: ApiWorkerEnv = {
		KODY_API: {
			async fetch() {
				throw new Error('binding down')
			},
		} as unknown as Fetcher,
	}
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/openapi.json'),
		env,
	)
	expect(response.status).toBe(503)
	expect(await response.json()).toMatchObject({
		error: { code: 'internal_error' },
	})
	expect(consoleError).toHaveBeenCalledWith(
		'api-worker-forward-failed',
		expect.any(Error),
	)
})
