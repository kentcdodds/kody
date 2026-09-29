import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ensureCommunityFlowSchema } from '#worker/community/community-flow-test-schema.ts'

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

test('public route hardening rejects retired connector paths, unknown paths, and abusive auth', async () => {
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

	const jsonPost = (body: unknown) => ({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const retiredConnectorRequests = [
		createRequest('/@connector-user/connectors/home/snapshot'),
		createRequest('/@connector-user/connectors/home/rpc/tools-list', {
			method: 'POST',
		}),
		createRequest(
			'/@connector-user/connectors/home/rpc/tools-call',
			jsonPost({ name: 'test', arguments: {} }),
		),
		createRequest(
			'/@connector-user/connectors/home/rpc/jsonrpc',
			jsonPost({ message: { jsonrpc: '2.0', method: 'ping', id: 1 } }),
		),
		createRequest('/@connector-user/connectors/home', {
			headers: { Upgrade: 'websocket' },
		}),
		createRequest('/connectors/home'),
	]
	for (const request of retiredConnectorRequests) {
		expect((await workerFetch(request)).status).toBe(404)
	}

	// Two segments is the public package URL `/@owner/kody-id`, even when the id
	// spells a retired machine namespace: it reaches the app and 404s as a page
	// rather than being swallowed by a special connector route.
	await ensureCommunityFlowSchema(env.APP_DB)
	const namespaceLookalikeResponse = await workerFetch(
		createRequest('/@connector-user/connectors'),
	)
	expect(namespaceLookalikeResponse.status).toBe(404)
	await expect(namespaceLookalikeResponse.text()).resolves.toContain(
		"This doesn't quite connect.",
	)

	// Real maintenance routes from index.ts share handleSecretMaintenanceRequest:
	// non-POST → 405 (proves registration vs unknown JSON 404); unauthenticated
	// POST → 401 when the secret is set, otherwise 503 not-configured.
	const registeredMaintenanceRoutes: Array<
		[path: string, secret: string | undefined, notConfigured: string | null]
	> = [
		[
			'reindex-capabilities',
			env.CAPABILITY_REINDEX_SECRET,
			'Capability reindex is not configured',
		],
		[
			'execute-smoke',
			env.CAPABILITY_REINDEX_SECRET,
			'Origin-only execute smoke check is not configured',
		],
		[
			'reindex-memories',
			env.CAPABILITY_REINDEX_SECRET,
			'Memory reindex is not configured',
		],
		['reindex-jobs', env.JOB_REINDEX_SECRET, 'Job reindex is not configured'],
		['dr-restore', env.DR_RESTORE_SECRET, 'DR restore is not configured'],
		[
			'dr-export',
			env.DR_RESTORE_SECRET,
			'DR export maintenance is not configured',
		],
		// null: non-production is forbidden before the secret is consulted.
		['do-pitr', env.DR_RESTORE_SECRET, null],
		[
			'dr-mailbox-import',
			env.DR_RESTORE_SECRET,
			'Mailbox import is not configured',
		],
		[
			'status-incidents',
			env.STATUS_INCIDENT_EVENT_SECRET,
			'Status incident events are not configured',
		],
		[
			'mcp-execute-health',
			env.STATUS_INCIDENT_EVENT_SECRET,
			'MCP execute health probe is not configured',
		],
	]

	for (const [name, secret, notConfigured] of registeredMaintenanceRoutes) {
		const path = `/__maintenance/${name}`
		const methodResponse = await workerFetch(createRequest(path))
		expect(methodResponse.status).toBe(405)
		await expect(methodResponse.text()).resolves.toBe('Method Not Allowed')

		const unauthorized = await workerFetch(
			createRequest(path, { method: 'POST' }),
		)
		const [status, body] =
			notConfigured === null
				? [403, 'Forbidden']
				: secret?.trim()
					? [401, 'Unauthorized']
					: [503, notConfigured]
		expect([unauthorized.status, await unauthorized.text()]).toEqual([
			status,
			body,
		])
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
		const response = await workerFetch(
			createRequest('/auth', {
				...jsonPost({
					email: 'attacker@example.com',
					password: 'password123',
					mode: 'login',
				}),
				headers: {
					'Content-Type': 'application/json',
					'CF-Connecting-IP': '198.51.100.42',
				},
			}),
		)
		if (response.status === 429) {
			rateLimited = true
			expect(response.headers.get('Retry-After')).toBeTruthy()
			break
		}
	}
	expect(rateLimited).toBe(true)
})
