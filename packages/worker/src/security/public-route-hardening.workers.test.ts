import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'

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

test('user-scoped connector entrypoints reject unauthenticated HTTP access while allowing WebSocket upgrades', async () => {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO users (username, email, password_hash)
			VALUES ('connector-user', 'connector-user@example.com', 'hash')`,
	).run()
	const unauthorizedRequests = [
		createRequest('/@connector-user/connectors/lights/default/snapshot'),
		createRequest('/@connector-user/connectors/lights/default/rpc/tools-list', {
			method: 'POST',
		}),
		createRequest('/@connector-user/connectors/lights/default/rpc/tools-call', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test', arguments: {} }),
		}),
		createRequest('/@connector-user/connectors/lights/default/rpc/jsonrpc', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: { jsonrpc: '2.0', method: 'ping', id: 1 },
			}),
		}),
	]

	for (const request of unauthorizedRequests) {
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
	}

	const websocketRequest = createRequest(
		'/@connector-user/connectors/lights/default',
		{
			headers: { Upgrade: 'websocket' },
		},
	)
	const websocketResponse = await workerFetch(websocketRequest)

	expect(websocketResponse.status).toBe(101)
	expect(websocketResponse.webSocket).toBeTruthy()
})

test('unmatched connector ingress paths do not fall through to the SPA shell', async () => {
	const requests = [
		createRequest('/@connector-user/connectors'),
		createRequest('/@connector-user/connectors/home', {
			headers: { Upgrade: 'websocket' },
		}),
	]

	for (const request of requests) {
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
		await expect(response.text()).resolves.toBe('Not Found')
	}
})

test('unknown maintenance endpoints return a consistent JSON 404 response', async () => {
	const requests = [
		createRequest('/__maintenance/reindex-skills', {
			method: 'POST',
		}),
		createRequest('/__maintenance/nonexistent'),
	]

	for (const request of requests) {
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
		await expect(response.json()).resolves.toEqual({
			error: 'Unknown maintenance endpoint.',
		})
	}
})

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
