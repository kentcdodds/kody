import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import type * as PackageInvocationServiceModule from '#worker/package-invocations/service.ts'
import { clearRunRecords, listRunRecords } from '#worker/run-records/service.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { computeWebhookHmacSignature, hashWebhookUrlSecret } from './crypto.ts'
import { handleWebhookIngressRequest } from './http.ts'

const mocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	resolveSecret: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', async () => {
	const actual = await vi.importActual<typeof PackageInvocationServiceModule>(
		'#worker/package-invocations/service.ts',
	)
	return {
		...actual,
		invokePackageExport: (...args: Array<unknown>) =>
			mocks.invokePackageExport(...args),
	}
})

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageManifestBySourceId(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecret: (...args: Array<unknown>) => mocks.resolveSecret(...args),
}))

async function ensureSchema(db: D1Database) {
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
			`CREATE TABLE IF NOT EXISTS saved_packages (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kody_id TEXT NOT NULL,
				description TEXT NOT NULL,
				tags_json TEXT NOT NULL DEFAULT '[]',
				search_text TEXT,
				source_id TEXT NOT NULL,
				has_app INTEGER NOT NULL DEFAULT 0,
				hidden INTEGER NOT NULL DEFAULT 0,
				is_private INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS webhook_endpoints (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				webhook_name TEXT NOT NULL,
				url_secret_hash TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				rotated_at TEXT NOT NULL
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

async function seedOwner() {
	const userId = await createStableUserIdFromEmail('alice@example.com')
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', ?)`,
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-1', ?, '@alice/sentry-bridge', 'sentry-bridge', 'Sentry bridge',
			'[]', 'src-1', 0, 0, 1, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
		)`,
	)
		.bind(userId)
		.run()
	return userId
}

async function mintWebhook(input: {
	userId: string
	webhookName: string
	urlSecret: string
	enabled?: boolean
	id?: string
}) {
	const now = '2026-07-24T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash,
			enabled, created_at, rotated_at
		) VALUES (?, ?, 'pkg-1', ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.id ?? crypto.randomUUID(),
			input.userId,
			input.webhookName,
			await hashWebhookUrlSecret(input.urlSecret),
			input.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run()
}

function declareWebhook(input: {
	name: string
	responseMode?: 'ack' | 'sync'
	verification?: {
		type: 'hmac-sha256'
		header: string
		secretName: string
		encoding: 'hex'
		prefix?: string
	} | null
}) {
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@alice/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: input.name,
						export: './handle-sentry-webhook',
						responseMode: input.responseMode ?? 'ack',
						...(input.verification ? { verification: input.verification } : {}),
					},
				],
			},
		},
	})
}

async function postWebhook(input: {
	packageKodyId: string
	webhookName: string
	urlSecret: string
	body?: string | Uint8Array
	headers?: Record<string, string>
}) {
	const ctx = createExecutionContext()
	const response = await handleWebhookIngressRequest(
		new Request(
			`https://test.kody.dev/@alice/webhooks/${input.packageKodyId}/${input.webhookName}/${input.urlSecret}`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(input.headers ?? {}),
				},
				body: input.body ?? JSON.stringify({ hello: 'world' }),
			},
		),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

async function listDeliveries(userId: string, webhookName: string) {
	const page = await listRunRecords({
		env,
		userId,
		filter: { surface: 'webhook' },
		limit: 100,
	})
	return page.runs.filter((run) => run.name === webhookName)
}

test('package-centered webhook ingress auth, HMAC, size cap, ack/sync, and isolation', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	await ensureSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages`).run()
	await env.APP_DB.prepare(`DELETE FROM users`).run()

	const userId = await seedOwner()
	await clearRunRecords({ env, userId })
	const urlSecret = 'url-secret-plain'
	await mintWebhook({ userId, webhookName: 'sentry', urlSecret })
	await mintWebhook({
		userId,
		webhookName: 'sync-hook',
		urlSecret,
		id: 'mint-sync',
	})
	await mintWebhook({
		userId,
		webhookName: 'disabled',
		urlSecret,
		enabled: false,
		id: 'mint-disabled',
	})

	declareWebhook({
		name: 'sentry',
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			secretName: 'githubWebhookSecret',
			encoding: 'hex',
			prefix: 'sha256=',
		},
	})

	mocks.invokePackageExport.mockReset()
	mocks.invokePackageExport.mockResolvedValue({
		status: 200,
		body: { ok: true, result: { handled: true } },
	})
	mocks.resolveSecret.mockResolvedValue({
		found: true,
		value: 'hmac-shared-secret',
		scope: 'user',
		allowedHosts: [],
		allowedCapabilities: [],
		allowedPackages: [],
	})

	const body = JSON.stringify({ event: 'push' })
	const signature = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: 'hmac-shared-secret',
		body: new TextEncoder().encode(body).buffer as ArrayBuffer,
		encoding: 'hex',
		prefix: 'sha256=',
	})

	const ack = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sentry',
		urlSecret,
		body,
		headers: { 'x-hub-signature-256': signature },
	})
	expect(ack.status).toBe(202)
	expect(mocks.invokePackageExport).toHaveBeenCalled()
	const invokeArgs = mocks.invokePackageExport.mock.calls[0]?.[0] as {
		token: { userId: string }
		request: {
			params: {
				webhook: { packageKodyId: string; name: string }
				request: { json: unknown }
			}
		}
	}
	expect(invokeArgs.token.userId).toBe(userId)
	expect(invokeArgs.request.params.webhook).toEqual({
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		receivedAt: expect.any(String),
	})
	expect(invokeArgs.request.params.request.json).toEqual({ event: 'push' })
	const delivered = (await listDeliveries(userId, 'sentry'))[0]
	expect(delivered?.status).toBe('success')
	expect(delivered?.packageId).toBe('pkg-1')
	expect(delivered?.kodyId).toBe('sentry-bridge')
	expect(delivered?.metadata).toMatchObject({
		httpStatus: 202,
		outcome: 'delivered',
		result: { handled: true },
	})

	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	mocks.invokePackageExport.mockClear()
	const sync = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sync-hook',
		urlSecret,
		body: JSON.stringify({ sync: true }),
	})
	expect(sync.status).toBe(200)
	await expect(sync.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect((await listDeliveries(userId, 'sync-hook'))[0]?.status).toBe('success')

	expect(
		(
			await postWebhook({
				packageKodyId: 'sentry-bridge',
				webhookName: 'sentry',
				urlSecret: 'wrong',
			})
		).status,
	).toBe(404)

	expect(
		(
			await postWebhook({
				packageKodyId: 'sentry-bridge',
				webhookName: 'disabled',
				urlSecret,
			})
		).status,
	).toBe(404)

	expect(
		(
			await postWebhook({
				packageKodyId: 'sentry-bridge',
				webhookName: 'never-minted',
				urlSecret,
			})
		).status,
	).toBe(404)

	declareWebhook({
		name: 'sentry',
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			secretName: 'githubWebhookSecret',
			encoding: 'hex',
			prefix: 'sha256=',
		},
	})
	const badHmac = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sentry',
		urlSecret,
		body,
		headers: { 'x-hub-signature-256': 'sha256=00' },
	})
	expect(badHmac.status).toBe(401)

	mocks.resolveSecret.mockResolvedValueOnce({
		found: false,
		value: null,
		scope: null,
		allowedHosts: [],
		allowedCapabilities: [],
		allowedPackages: [],
	})
	const missingSecret = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sentry',
		urlSecret,
		body,
		headers: { 'x-hub-signature-256': signature },
	})
	expect(missingSecret.status).toBe(401)
	expect(
		(await listDeliveries(userId, 'sentry')).some(
			(run) =>
				run.status === 'error' &&
				typeof run.errorMessage === 'string' &&
				run.errorMessage.startsWith('verification_secret_missing:'),
		),
	).toBe(true)

	// Removed from manifest → 404
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@alice/sentry-bridge',
			exports: { '.': './index.ts' },
			kody: { id: 'sentry-bridge', description: 'Sentry bridge' },
		},
	})
	expect(
		(
			await postWebhook({
				packageKodyId: 'sentry-bridge',
				webhookName: 'sentry',
				urlSecret,
			})
		).status,
	).toBe(404)

	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	const tooLarge = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sync-hook',
		urlSecret,
		body: new Uint8Array(1024 * 1024 + 1),
		headers: { 'content-type': 'application/octet-stream' },
	})
	expect(tooLarge.status).toBe(413)
})

test('webhook delivery records real startedAt duration and explicit delivered outcome with handler result', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	await ensureSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages`).run()
	await env.APP_DB.prepare(`DELETE FROM users`).run()

	const userId = await seedOwner()
	await clearRunRecords({ env, userId })
	const urlSecret = 'url-secret-plain'
	await mintWebhook({
		userId,
		webhookName: 'sync-hook',
		urlSecret,
		id: 'mint-sync-delivered',
	})
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })

	mocks.invokePackageExport.mockReset()
	mocks.invokePackageExport.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 25))
		return {
			status: 200,
			body: { ok: true, result: { handled: true } },
		}
	})

	const response = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sync-hook',
		urlSecret,
		body: JSON.stringify({ sync: true }),
	})
	expect(response.status).toBe(200)

	const invokeArgs = mocks.invokePackageExport.mock.calls[0]?.[0] as {
		request: {
			params: { webhook: { receivedAt: string } }
		}
	}
	const delivered = (await listDeliveries(userId, 'sync-hook'))[0]
	expect(delivered?.status).toBe('success')
	expect(delivered?.startedAt).toBe(
		invokeArgs.request.params.webhook.receivedAt,
	)
	expect(delivered?.durationMs).toBeGreaterThan(0)
	expect(delivered?.metadata).toMatchObject({
		outcome: 'delivered',
		httpStatus: 200,
		result: { handled: true },
	})
})

test('webhook delivery records explicit rejected and failed outcomes', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	await ensureSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages`).run()
	await env.APP_DB.prepare(`DELETE FROM users`).run()

	const userId = await seedOwner()
	await clearRunRecords({ env, userId })
	const urlSecret = 'url-secret-plain'
	await mintWebhook({
		userId,
		webhookName: 'sync-hook',
		urlSecret,
		id: 'mint-sync-outcomes',
	})
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })

	const tooLarge = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sync-hook',
		urlSecret,
		body: new Uint8Array(1024 * 1024 + 1),
		headers: { 'content-type': 'application/octet-stream' },
	})
	expect(tooLarge.status).toBe(413)
	const rejected = (await listDeliveries(userId, 'sync-hook')).find(
		(run) => run.metadata?.['outcome'] === 'rejected',
	)
	expect(rejected?.metadata).toMatchObject({
		outcome: 'rejected',
		httpStatus: 413,
	})

	mocks.invokePackageExport.mockReset()
	mocks.invokePackageExport.mockResolvedValue({
		status: 500,
		body: { ok: false },
	})
	const failedResponse = await postWebhook({
		packageKodyId: 'sentry-bridge',
		webhookName: 'sync-hook',
		urlSecret,
		body: JSON.stringify({ boom: true }),
	})
	expect(failedResponse.status).toBe(502)
	const failed = (await listDeliveries(userId, 'sync-hook')).find(
		(run) => run.metadata?.['outcome'] === 'failed',
	)
	expect(failed?.status).toBe('error')
	expect(failed?.metadata).toMatchObject({
		outcome: 'failed',
		httpStatus: 502,
	})
})
