import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

async function workerFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

describe('Finding 1A: connector route hardening', () => {
	test('GET /home/connectors/default/snapshot without upgrade returns 404', async () => {
		const request = createRequest('/home/connectors/default/snapshot')
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	})

	test('POST /home/connectors/default/rpc/tools-list without auth returns 404', async () => {
		const request = createRequest('/home/connectors/default/rpc/tools-list', {
			method: 'POST',
		})
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	})

	test('POST /home/connectors/default/rpc/tools-call without auth returns 404', async () => {
		const request = createRequest('/home/connectors/default/rpc/tools-call', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test', arguments: {} }),
		})
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	})

	test('POST /home/connectors/default/rpc/jsonrpc without auth returns 404', async () => {
		const request = createRequest('/home/connectors/default/rpc/jsonrpc', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: { jsonrpc: '2.0', method: 'ping', id: 1 },
			}),
		})
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	})

	test('GET /connectors/home/default/snapshot without upgrade returns 404', async () => {
		const request = createRequest('/connectors/home/default/snapshot')
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	})

	test('WebSocket upgrade to connector route is accepted by the entrypoint', async () => {
		const request = createRequest('/home/connectors/default', {
			headers: { Upgrade: 'websocket' },
		})
		const response = await workerFetch(request)
		expect(response.status).toBe(101)
		expect(response.webSocket).toBeTruthy()
	})
})

describe('Finding 1C: maintenance route gap', () => {
	test('POST /__maintenance/reindex-skills returns 404 JSON', async () => {
		const request = createRequest('/__maintenance/reindex-skills', {
			method: 'POST',
		})
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
		const body = (await response.json()) as { error: string }
		expect(body.error).toBe('Unknown maintenance endpoint.')
	})

	test('GET /__maintenance/nonexistent returns 404 JSON', async () => {
		const request = createRequest('/__maintenance/nonexistent')
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
		const body = (await response.json()) as { error: string }
		expect(body.error).toBe('Unknown maintenance endpoint.')
	})
})

describe('Finding 1B: auth rate limiting', () => {
	test('repeated POST /auth attempts trigger 429', async () => {
		let rateLimited = false
		for (let i = 0; i < 25; i++) {
			const request = createRequest('/auth', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'CF-Connecting-IP': '198.51.100.42',
				},
				body: JSON.stringify({
					email: 'attacker@example.com',
					password: 'password123',
					mode: 'login',
				}),
			})
			const response = await workerFetch(request)
			if (response.status === 429) {
				rateLimited = true
				const retryAfter = response.headers.get('Retry-After')
				expect(retryAfter).toBeTruthy()
				break
			}
		}
		expect(rateLimited).toBe(true)
	})
})
