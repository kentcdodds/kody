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

test('public route hardening rejects unauthenticated connector and maintenance access, unknown paths, and abusive auth while allowing websocket upgrades', async () => {
	await env.APP_DB.prepare(`DROP TABLE IF EXISTS users`).run()
	await env.APP_DB.prepare(
		`CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (
				'connector-user',
				'connector-user@example.com',
				'hash',
				'connector-user-stable-id'
			)`,
	).run()

	const unauthorizedConnectorRequests = [
		createRequest('/@connector-user/connectors/home/snapshot'),
		createRequest('/@connector-user/connectors/home/rpc/tools-list', {
			method: 'POST',
		}),
		createRequest('/@connector-user/connectors/home/rpc/tools-call', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test', arguments: {} }),
		}),
		createRequest('/@connector-user/connectors/home/rpc/jsonrpc', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: { jsonrpc: '2.0', method: 'ping', id: 1 },
			}),
		}),
		createRequest('/@connector-user/connectors'),
	]
	for (const request of unauthorizedConnectorRequests) {
		const response = await workerFetch(request)
		expect(response.status).toBe(404)
		if (request.url.endsWith('/connectors')) {
			await expect(response.text()).resolves.toBe('Not Found')
		}
	}

	const websocketRequest = createRequest('/@connector-user/connectors/home', {
		headers: { Upgrade: 'websocket' },
	})
	const websocketResponse = await workerFetch(websocketRequest)
	expect(websocketResponse.status).toBe(101)
	expect(websocketResponse.webSocket).toBeTruthy()

	// Real maintenance routes from index.ts share handleSecretMaintenanceRequest:
	// non-POST → 405 (proves registration vs unknown JSON 404); unauthenticated
	// POST → 401 when the secret is set, otherwise 503 not-configured.
	const registeredMaintenanceRoutes = [
		{
			path: '/__maintenance/reindex-capabilities',
			secret: env.CAPABILITY_REINDEX_SECRET,
			notConfiguredMessage: 'Capability reindex is not configured',
		},
		{
			path: '/__maintenance/execute-smoke',
			secret: env.CAPABILITY_REINDEX_SECRET,
			notConfiguredMessage: 'Execute smoke check is not configured',
		},
		{
			path: '/__maintenance/reindex-memories',
			secret: env.CAPABILITY_REINDEX_SECRET,
			notConfiguredMessage: 'Memory reindex is not configured',
		},
		{
			path: '/__maintenance/reindex-jobs',
			secret: env.JOB_REINDEX_SECRET,
			notConfiguredMessage: 'Job reindex is not configured',
		},
		{
			path: '/__maintenance/dr-restore',
			secret: env.DR_RESTORE_SECRET,
			notConfiguredMessage: 'DR restore is not configured',
		},
	] as const

	for (const route of registeredMaintenanceRoutes) {
		const methodResponse = await workerFetch(createRequest(route.path))
		expect(methodResponse.status).toBe(405)
		await expect(methodResponse.text()).resolves.toBe('Method Not Allowed')

		const unauthorizedResponse = await workerFetch(
			createRequest(route.path, { method: 'POST' }),
		)
		if (route.secret?.trim()) {
			expect(unauthorizedResponse.status).toBe(401)
			await expect(unauthorizedResponse.text()).resolves.toBe('Unauthorized')
		} else {
			expect(unauthorizedResponse.status).toBe(503)
			await expect(unauthorizedResponse.text()).resolves.toBe(
				route.notConfiguredMessage,
			)
		}
	}

	const unknownMaintenanceResponse = await workerFetch(
		createRequest('/__maintenance/nonexistent'),
	)
	expect(unknownMaintenanceResponse.status).toBe(404)
	await expect(unknownMaintenanceResponse.json()).resolves.toEqual({
		error: 'Unknown maintenance endpoint.',
	})

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
			expect(response.headers.get('Retry-After')).toBeTruthy()
			break
		}
	}
	expect(rateLimited).toBe(true)
})
