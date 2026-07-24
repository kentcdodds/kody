import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import type * as PackageInvocationServiceModule from '#worker/package-invocations/service.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { encryptSecretValue } from '#mcp/secrets/crypto.ts'
import { computeWebhookHmacSignature, hashWebhookUrlSecret } from './crypto.ts'
import { handleWebhookIngressRequest } from './http.ts'
import { serializeStoredWebhookVerificationConfig } from './verification.ts'

const invocationMockModule = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', async () => {
	const actual = await vi.importActual<typeof PackageInvocationServiceModule>(
		'#worker/package-invocations/service.ts',
	)
	return {
		...actual,
		invokePackageExport: (...args: Array<unknown>) =>
			invocationMockModule.invokePackageExport(...args),
	}
})

async function ensureWebhookTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				username TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				stable_user_id TEXT NOT NULL,
				deleting_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS webhook_endpoints (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				package_id TEXT NOT NULL,
				export_name TEXT NOT NULL,
				url_secret_hash TEXT NOT NULL,
				verification_config TEXT,
				response_mode TEXT NOT NULL DEFAULT 'ack',
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS webhook_deliveries (
				id TEXT PRIMARY KEY,
				endpoint_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				received_at TEXT NOT NULL,
				outcome TEXT NOT NULL,
				http_status INTEGER NOT NULL,
				error TEXT,
				payload_bytes INTEGER NOT NULL DEFAULT 0
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS remote_connector_settings (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				instance_id TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				attached INTEGER NOT NULL DEFAULT 1,
				encrypted_shared_secret TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
}

async function seedUser(input: {
	username: string
	email: string
}): Promise<string> {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO users (username, email, password_hash, stable_user_id)
		VALUES (?, ?, 'hash', ?)`,
	)
		.bind(input.username, input.email, stableUserId)
		.run()
	return stableUserId
}

async function seedEndpoint(input: {
	id: string
	userId: string
	name: string
	urlSecret: string
	enabled?: boolean
	responseMode?: 'ack' | 'sync'
	verificationConfig?: string | null
	packageId?: string
	exportName?: string
}) {
	const now = '2026-07-24T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO webhook_endpoints (
			id, user_id, name, package_id, export_name, url_secret_hash,
			verification_config, response_mode, enabled, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.userId,
			input.name,
			input.packageId ?? 'pkg-1',
			input.exportName ?? './handle-webhook',
			await hashWebhookUrlSecret(input.urlSecret),
			input.verificationConfig ?? null,
			input.responseMode ?? 'ack',
			input.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run()
}

async function listDeliveries(endpointId: string) {
	const result = await env.APP_DB.prepare(
		`SELECT outcome, http_status, error, payload_bytes, user_id
		FROM webhook_deliveries
		WHERE endpoint_id = ?
		ORDER BY received_at DESC`,
	)
		.bind(endpointId)
		.all<{
			outcome: string
			http_status: number
			error: string | null
			payload_bytes: number
			user_id: string
		}>()
	return result.results ?? []
}

async function postWebhook(input: {
	username: string
	endpointId: string
	urlSecret: string
	body?: string | Uint8Array
	headers?: Record<string, string>
	ctx?: ExecutionContext
}) {
	const ctx = input.ctx ?? createExecutionContext()
	const body = input.body ?? JSON.stringify({ hello: 'world' })
	const response = await handleWebhookIngressRequest(
		new Request(
			`https://test.kody.dev/@${input.username}/webhooks/${input.endpointId}/${input.urlSecret}`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(input.headers ?? {}),
				},
				body,
			},
		),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

test('webhook ingress authenticates URL secret, rejects mismatches/disabled, verifies HMAC, caps size, and dispatches ack/sync', async () => {
	await ensureWebhookTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM webhook_deliveries`).run()
	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await env.APP_DB.prepare(`DELETE FROM users`).run()

	const ownerId = await seedUser({
		username: 'alice',
		email: 'alice@example.com',
	})
	const otherId = await seedUser({
		username: 'bob',
		email: 'bob@example.com',
	})

	const urlSecret = 'url-secret-plain'
	const hmacSecret = 'hmac-shared-secret'
	const verificationConfig = serializeStoredWebhookVerificationConfig({
		type: 'hmac-sha256',
		header: 'x-hub-signature-256',
		encoding: 'hex',
		prefix: 'sha256=',
		encryptedSecret: await encryptSecretValue(env, hmacSecret),
	})

	await seedEndpoint({
		id: 'ep-ack',
		userId: ownerId,
		name: 'ack-endpoint',
		urlSecret,
		responseMode: 'ack',
		verificationConfig,
	})
	await seedEndpoint({
		id: 'ep-sync',
		userId: ownerId,
		name: 'sync-endpoint',
		urlSecret,
		responseMode: 'sync',
	})
	await seedEndpoint({
		id: 'ep-disabled',
		userId: ownerId,
		name: 'disabled-endpoint',
		urlSecret,
		enabled: false,
	})
	await seedEndpoint({
		id: 'ep-other',
		userId: otherId,
		name: 'other-user',
		urlSecret: 'other-secret',
	})

	invocationMockModule.invokePackageExport.mockReset()
	invocationMockModule.invokePackageExport.mockResolvedValue({
		status: 200,
		body: { ok: true, result: { handled: true } },
	})

	const body = JSON.stringify({ event: 'push' })
	const signature = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: hmacSecret,
		body: new TextEncoder().encode(body).buffer as ArrayBuffer,
		encoding: 'hex',
		prefix: 'sha256=',
	})

	const ackResponse = await postWebhook({
		username: 'alice',
		endpointId: 'ep-ack',
		urlSecret,
		body,
		headers: { 'x-hub-signature-256': signature },
	})
	expect(ackResponse.status).toBe(202)
	await expect(ackResponse.json()).resolves.toEqual({ ok: true })
	expect(invocationMockModule.invokePackageExport).toHaveBeenCalled()
	const invokeArgs = invocationMockModule.invokePackageExport.mock
		.calls[0]?.[0] as {
		token: { userId: string; packageIds: Array<string> }
		request: {
			params: { webhook: { endpointId: string }; request: { json: unknown } }
		}
	}
	expect(invokeArgs.token.userId).toBe(ownerId)
	expect(invokeArgs.token.packageIds).toEqual(['pkg-1'])
	expect(invokeArgs.request.params.webhook.endpointId).toBe('ep-ack')
	expect(invokeArgs.request.params.request.json).toEqual({ event: 'push' })

	const ackDeliveries = await listDeliveries('ep-ack')
	expect(ackDeliveries[0]?.outcome).toBe('delivered')
	expect(ackDeliveries[0]?.http_status).toBe(202)
	expect(ackDeliveries[0]?.user_id).toBe(ownerId)

	invocationMockModule.invokePackageExport.mockClear()
	const syncResponse = await postWebhook({
		username: 'alice',
		endpointId: 'ep-sync',
		urlSecret,
		body: JSON.stringify({ sync: true }),
	})
	expect(syncResponse.status).toBe(200)
	await expect(syncResponse.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledTimes(1)

	const badSecret = await postWebhook({
		username: 'alice',
		endpointId: 'ep-sync',
		urlSecret: 'wrong-secret',
	})
	expect(badSecret.status).toBe(404)

	const disabled = await postWebhook({
		username: 'alice',
		endpointId: 'ep-disabled',
		urlSecret,
	})
	expect(disabled.status).toBe(404)

	const crossUser = await postWebhook({
		username: 'alice',
		endpointId: 'ep-other',
		urlSecret: 'other-secret',
	})
	expect(crossUser.status).toBe(404)
	const otherDeliveries = await listDeliveries('ep-other')
	expect(otherDeliveries[0]?.outcome).toBe('rejected')
	expect(otherDeliveries[0]?.user_id).toBe(otherId)

	const badHmac = await postWebhook({
		username: 'alice',
		endpointId: 'ep-ack',
		urlSecret,
		body,
		headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
	})
	expect(badHmac.status).toBe(401)
	const rejectedHmac = (await listDeliveries('ep-ack')).find(
		(row) => row.error === 'invalid_signature',
	)
	expect(rejectedHmac?.outcome).toBe('rejected')

	const oversized = new Uint8Array(1024 * 1024 + 1)
	const tooLarge = await postWebhook({
		username: 'alice',
		endpointId: 'ep-sync',
		urlSecret,
		body: oversized,
		headers: { 'content-type': 'application/octet-stream' },
	})
	expect(tooLarge.status).toBe(413)
	const sizeReject = (await listDeliveries('ep-sync')).find(
		(row) => row.error === 'payload_too_large',
	)
	expect(sizeReject?.outcome).toBe('rejected')

	invocationMockModule.invokePackageExport.mockResolvedValueOnce({
		status: 500,
		body: { ok: false },
	})
	const syncFail = await postWebhook({
		username: 'alice',
		endpointId: 'ep-sync',
		urlSecret,
		body: JSON.stringify({ fail: true }),
	})
	expect(syncFail.status).toBe(502)
})
