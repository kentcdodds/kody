import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { checkRateLimit } from '#app/rate-limit.ts'
import { type PackageInvocationRequest } from '#worker/package-invocations/common.ts'
import {
	createRequestHash,
	resolveExistingInvocation,
	type ResolvableInvocationRecord,
} from '#worker/package-invocations/idempotency.ts'
import type * as PackageInvocationServiceModule from '#worker/package-invocations/service.ts'
import { type PackageWebhookManifestEntry } from '#worker/package-registry/manifest.ts'
import { clearRunRecords, listRunRecords } from '#worker/run-records/service.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	buildWebhookTimestampBodyPayload,
	computeWebhookHmacSignature,
	hashWebhookUrlSecret,
} from './crypto.ts'
import type * as DispatchQueueProducerModule from './dispatch-queue-producer.ts'
import { handleWebhookIngressRequest } from './http.ts'
import { webhookRateLimitConfig } from './types.ts'

const mocks = vi.hoisted(() => ({
	enqueueWebhookDispatch: vi.fn(),
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

vi.mock('./dispatch-queue-producer.ts', async () => {
	const actual = await vi.importActual<typeof DispatchQueueProducerModule>(
		'./dispatch-queue-producer.ts',
	)
	return {
		...actual,
		enqueueWebhookDispatch: (...args: Array<unknown>) =>
			mocks.enqueueWebhookDispatch(...args),
	}
})

const handledResponse = {
	status: 200,
	body: { ok: true, result: { handled: true } },
}

function createHashedIdempotencyExportMock() {
	const ledger = new Map<string, ResolvableInvocationRecord>()
	let exportInvocations = 0
	const implementation = async (input: {
		request: PackageInvocationRequest
	}) => {
		const key = input.request.idempotencyKey
		if (!key) {
			exportInvocations += 1
			return handledResponse
		}
		const ignoreParams = input.request.idempotencyParamsHash === 'ignore'
		const requestHash = await createRequestHash({
			packageId: input.request.packageIdOrKodyId,
			exportName: input.request.exportName,
			params: ignoreParams ? undefined : input.request.params,
			source: input.request.source ?? null,
			topic: input.request.topic ?? null,
		})
		const existing = ledger.get(key)
		if (existing) {
			return resolveExistingInvocation({
				record: existing,
				requestHash,
				idempotencyKey: key,
				paramsHash: ignoreParams ? 'ignore' : 'include',
			})
		}
		exportInvocations += 1
		ledger.set(key, {
			requestHash,
			status: 'completed',
			storedResponse: handledResponse,
		})
		return handledResponse
	}
	mocks.invokePackageExport.mockImplementation(implementation)
	return {
		get exportInvocations() {
			return exportInvocations
		},
	}
}

async function ensureSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				username TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				stable_user_id TEXT NOT NULL,
				deleting_at TEXT,
				suspended_at TEXT
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
				locked_at TEXT,
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
				url_secret_encrypted TEXT,
				hmac_secret_encrypted TEXT,
				previous_url_secret_hash TEXT,
				previous_url_secret_expires_at TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				rotated_at TEXT NOT NULL
			)`,
		)
		.run()
}

const urlSecret = 'url-secret-plain'
const hmacSecret = 'hmac-shared-secret'
const githubVerification = {
	type: 'hmac-sha256',
	header: 'x-hub-signature-256',
	secretName: 'githubWebhookSecret',
	encoding: 'hex',
	prefix: 'sha256=',
} as const

async function mintWebhook(input: {
	userId: string
	webhookName: string
	urlSecret?: string
	enabled?: boolean
	previousUrlSecret?: string
	previousExpiresAt?: string
}) {
	const now = '2026-07-24T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash,
			previous_url_secret_hash, previous_url_secret_expires_at,
			enabled, created_at, rotated_at
		) VALUES (?, ?, 'pkg-1', ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`mint-${input.webhookName}`,
			input.userId,
			input.webhookName,
			await hashWebhookUrlSecret(input.urlSecret ?? urlSecret),
			input.previousUrlSecret
				? await hashWebhookUrlSecret(input.previousUrlSecret)
				: null,
			input.previousExpiresAt ?? null,
			input.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run()
}

async function setupOwnerWithWebhooks(webhookNames: Array<string>) {
	await ensureSchema(env.APP_DB)
	for (const table of ['webhook_endpoints', 'saved_packages', 'users']) {
		await env.APP_DB.prepare(`DELETE FROM ${table}`).run()
	}
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
	await clearRunRecords({ env, userId })
	for (const webhookName of webhookNames) {
		await mintWebhook({ userId, webhookName })
	}
	mocks.enqueueWebhookDispatch.mockResolvedValue(undefined)
	mocks.invokePackageExport.mockResolvedValue(handledResponse)
	return userId
}

function suspendOwner(userId: string, at: string) {
	return env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(at, userId)
		.run()
}

const secretLookup = (value: string | null) => ({
	found: value !== null,
	value,
	scope: value === null ? null : 'user',
	allowedHosts: [],
	allowedPackages: [],
})

function mockSecretValue(value: string | null) {
	mocks.resolveSecret.mockResolvedValue(secretLookup(value))
}

type WebhookDeclaration = { name: string } & {
	[
		K in
			| 'responseMode'
			| 'inputMode'
			| 'rateLimitPerMinute'
			| 'verification'
			| 'replay'
			| 'challenge'
	]?: NonNullable<PackageWebhookManifestEntry[K]>
}

function declareWebhook(input: WebhookDeclaration) {
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
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						...input,
					},
				],
			},
		},
	})
}

function encodeBody(text: string) {
	const bytes = new TextEncoder().encode(text)
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function sign(
	body: string | ArrayBuffer,
	prefix: string | null = 'sha256=',
	secret = hmacSecret,
) {
	return computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret,
		body: typeof body === 'string' ? encodeBody(body) : body,
		encoding: 'hex',
		prefix: prefix ?? undefined,
	})
}

async function sendWebhook(
	webhookName: string,
	init: {
		method?: 'GET' | 'POST'
		query?: string
		urlSecret?: string
		body?: string | Uint8Array
		headers?: Record<string, string>
	} = {},
) {
	const method = init.method ?? 'POST'
	const ctx = createExecutionContext()
	const response = await handleWebhookIngressRequest(
		new Request(
			`https://test.kody.dev/@alice/webhooks/sentry-bridge/${webhookName}/${init.urlSecret ?? urlSecret}${init.query ? `?${init.query}` : ''}`,
			method === 'GET'
				? { method }
				: {
						method,
						headers: { 'content-type': 'application/json', ...init.headers },
						body: (init.body ?? JSON.stringify({ hello: 'world' })) as BodyInit,
					},
		),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

async function statusOf(...args: Parameters<typeof sendWebhook>) {
	return (await sendWebhook(...args)).status
}

type EnqueuedMessage = {
	deliveryId: string
	endpoint: { userId: string }
	payloadKvKey?: string
	callerIdempotency?: true
	params: {
		webhook: { packageKodyId: string; name: string }
		request: { body: string; json: unknown }
	}
}

type InvokedRequest = {
	params: Record<string, unknown> & {
		webhook: { name: string; receivedAt: string }
		request: { json: unknown }
	}
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	idempotencyHashParams?: Record<string, unknown>
}

const enqueued = (index: number): EnqueuedMessage =>
	mocks.enqueueWebhookDispatch.mock.calls[index]![0].message
const invoked = (index: number): InvokedRequest =>
	mocks.invokePackageExport.mock.calls.at(index)![0].request

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
	const userId = await setupOwnerWithWebhooks(['sentry', 'sync-hook'])
	await mintWebhook({ userId, webhookName: 'disabled', enabled: false })
	declareWebhook({ name: 'sentry', verification: githubVerification })
	mockSecretValue(hmacSecret)

	const body = JSON.stringify({ event: 'push' })
	const signature = await sign(body)
	const signed = { body, headers: { 'x-hub-signature-256': signature } }

	expect(await statusOf('sentry', signed)).toBe(202)
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(1)
	expect(enqueued(0).endpoint.userId).toBe(userId)
	expect(enqueued(0).params.webhook).toEqual({
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		receivedAt: expect.any(String),
	})
	expect(enqueued(0).params.request.json).toBeNull()
	expect(enqueued(0).params.request.body).toBe(body)
	expect(enqueued(0).payloadKvKey).toBeUndefined()

	declareWebhook({ name: 'sentry' })
	const midSizeBody = JSON.stringify({ payload: 'x'.repeat(70_000) })
	expect(await statusOf('sentry', { body: midSizeBody })).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(enqueued(1).payloadKvKey).toBeUndefined()
	expect(enqueued(1).params.request.json).toBeNull()

	const largeBody = JSON.stringify({ payload: 'y'.repeat(140_000) })
	expect(await statusOf('sentry', { body: largeBody })).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(3)
	const large = enqueued(2)
	expect(large.params.request.body).toBe('')
	expect(large.params.request.json).toBeNull()
	expect(large.payloadKvKey).toBe(
		`webhook-dispatch-payload:v1:${large.endpoint.userId}:${large.deliveryId}`,
	)
	expect(await env.BUNDLE_ARTIFACTS_KV.get(large.payloadKvKey!)).toBe(largeBody)

	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	const sync = await sendWebhook('sync-hook', {
		body: JSON.stringify({ sync: true }),
	})
	expect(sync.status).toBe(200)
	await expect(sync.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect((await listDeliveries(userId, 'sync-hook'))[0]?.status).toBe('success')

	expect(await statusOf('sentry', { urlSecret: 'wrong' })).toBe(404)
	expect(await statusOf('disabled')).toBe(404)
	expect(await statusOf('never-minted')).toBe(404)

	declareWebhook({ name: 'sentry', verification: githubVerification })
	expect(
		await statusOf('sentry', {
			body,
			headers: { 'x-hub-signature-256': 'sha256=00' },
		}),
	).toBe(401)

	mocks.resolveSecret.mockResolvedValueOnce(secretLookup(null))
	expect(await statusOf('sentry', signed)).toBe(401)
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
	expect(await statusOf('sentry')).toBe(404)
})

test('webhook delivery records real startedAt duration and explicit delivered outcome with handler result', async () => {
	const userId = await setupOwnerWithWebhooks(['sync-hook'])
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })

	vi.useFakeTimers({ shouldAdvanceTime: true })
	let releaseHandler!: () => void
	const handlerGate = new Promise<void>((resolve) => {
		releaseHandler = resolve
	})
	mocks.invokePackageExport.mockImplementation(async () => {
		await handlerGate
		return handledResponse
	})

	const responsePromise = sendWebhook('sync-hook', {
		body: JSON.stringify({ sync: true }),
	})
	await vi.waitFor(() => mocks.invokePackageExport.mock.calls.length === 1)
	await vi.advanceTimersByTimeAsync(25)
	releaseHandler()
	const response = await responsePromise
	vi.useRealTimers()
	expect(response.status).toBe(200)

	const delivered = (await listDeliveries(userId, 'sync-hook'))[0]
	expect(delivered?.status).toBe('success')
	expect(delivered?.startedAt).toBe(invoked(0).params.webhook.receivedAt)
	expect(delivered?.durationMs).toBeGreaterThan(0)
	expect(delivered?.metadata).toMatchObject({
		outcome: 'delivered',
		httpStatus: 200,
		result: { handled: true },
	})
})

test('webhook delivery records explicit rejected and failed outcomes', async () => {
	const userId = await setupOwnerWithWebhooks(['sync-hook'])
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	const findOutcome = async (outcome: string) =>
		(await listDeliveries(userId, 'sync-hook')).find(
			(run) => run.metadata?.['outcome'] === outcome,
		)

	expect(
		await statusOf('sync-hook', {
			body: new Uint8Array(1024 * 1024 + 1),
			headers: { 'content-type': 'application/octet-stream' },
		}),
	).toBe(413)
	expect((await findOutcome('rejected'))?.metadata).toMatchObject({
		outcome: 'rejected',
		httpStatus: 413,
	})

	mocks.invokePackageExport.mockResolvedValue({
		status: 500,
		body: { ok: false },
	})
	expect(
		await statusOf('sync-hook', { body: JSON.stringify({ boom: true }) }),
	).toBe(502)
	const failed = await findOutcome('failed')
	expect(failed?.status).toBe('error')
	expect(failed?.metadata).toMatchObject({ outcome: 'failed', httpStatus: 502 })
})

test('webhook ingress rejects suspended owners before any dispatch', async () => {
	const userId = await setupOwnerWithWebhooks(['ack-hook', 'sync-hook'])
	await suspendOwner(userId, '2026-09-23T00:00:00.000Z')

	for (const hook of [
		{ name: 'ack-hook', responseMode: 'ack' as const },
		{ name: 'sync-hook', responseMode: 'sync' as const },
	]) {
		declareWebhook(hook)
		const response = await sendWebhook(hook.name)
		expect(response.status).toBe(403)
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: { code: 'account_suspended' },
		})
		const deliveries = await listDeliveries(userId, hook.name)
		expect(deliveries[0]?.metadata).toMatchObject({
			outcome: 'rejected',
			httpStatus: 403,
		})
		expect(deliveries[0]?.errorMessage).toBe('account_suspended')
	}
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()
	expect(mocks.enqueueWebhookDispatch).not.toHaveBeenCalled()
})

test('opt-in webhook replay protection rejects stale timestamps and dedupes delivery ids', async () => {
	await setupOwnerWithWebhooks(['stripe', 'github', 'unix'])
	mockSecretValue(hmacSecret)

	const body = JSON.stringify({ event: 'invoice.paid' })
	const nowSeconds = Math.floor(Date.now() / 1000)
	const stripeHeader = async (seconds: number) => {
		const payload = buildWebhookTimestampBodyPayload({
			timestampToken: String(seconds),
			body: encodeBody(body),
		})
		return {
			'stripe-signature': `t=${seconds},v1=${await sign(payload, null)}`,
		}
	}

	declareWebhook({
		name: 'stripe',
		verification: {
			type: 'hmac-sha256',
			header: 'stripe-signature',
			secretName: 'stripeWebhookSecret',
			encoding: 'hex',
			signedPayload: 'timestamp.body',
		},
		replay: {
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
			toleranceSeconds: 300,
		},
	})

	const acceptedStripe = await sendWebhook('stripe', {
		body,
		headers: await stripeHeader(nowSeconds),
	})
	expect(acceptedStripe.status).toBe(202)
	expect(await acceptedStripe.json()).toEqual({ ok: true })

	const staleStripe = await sendWebhook('stripe', {
		body,
		headers: await stripeHeader(nowSeconds - 1000),
	})
	expect(staleStripe.status).toBe(401)
	expect(await staleStripe.json()).toEqual({
		ok: false,
		error: {
			code: 'invalid_signature',
			message: 'Webhook signature verification failed.',
		},
	})
	expect(await statusOf('stripe', { body })).toBe(401)
	const bodyOnlySignature = await sign(body, null)
	expect(
		await statusOf('stripe', {
			body,
			headers: {
				'stripe-signature': `t=${nowSeconds},v1=${bodyOnlySignature}`,
			},
		}),
	).toBe(401)

	for (const [timestampFormat, timestamp, status] of [
		['unix-seconds', String(nowSeconds), 202],
		['unix-seconds', String(nowSeconds * 1000), 401],
		['unix-millis', String(Date.now()), 202],
		['iso-8601', new Date().toISOString(), 202],
	] as const) {
		declareWebhook({
			name: 'unix',
			replay: { timestampHeader: 'X-Timestamp', timestampFormat },
		})
		expect(
			await statusOf('unix', { body, headers: { 'x-timestamp': timestamp } }),
		).toBe(status)
	}

	declareWebhook({
		name: 'github',
		responseMode: 'sync',
		verification: githubVerification,
		replay: { deliveryIdHeader: 'X-GitHub-Delivery' },
	})
	const githubBody = JSON.stringify({ ref: 'refs/heads/main' })
	const githubHeaders = {
		'x-hub-signature-256': await sign(githubBody),
		'x-github-delivery': 'delivery-abc',
	}
	const exportMock = createHashedIdempotencyExportMock()

	const firstGithub = await sendWebhook('github', {
		body: githubBody,
		headers: githubHeaders,
	})
	const firstGithubBody = await firstGithub.json()
	expect(firstGithub.status).toBe(200)
	expect(firstGithubBody).toEqual({ ok: true, result: { handled: true } })

	await new Promise((resolve) => setTimeout(resolve, 10))

	const replayedGithub = await sendWebhook('github', {
		body: githubBody,
		headers: githubHeaders,
	})
	expect(replayedGithub.status).toBe(200)
	expect(await replayedGithub.json()).toEqual(firstGithubBody)
	expect(exportMock.exportInvocations).toBe(1)
	expect(mocks.invokePackageExport).toHaveBeenCalledTimes(2)
	const [firstCall, secondCall] = [invoked(0), invoked(1)]
	expect(firstCall.idempotencyKey).toBe(secondCall.idempotencyKey)
	expect(firstCall.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
	expect(firstCall.idempotencyParamsHash).toBe('ignore')
	expect(secondCall.idempotencyParamsHash).toBe('ignore')
	expect(firstCall.params.webhook.receivedAt).not.toBe(
		secondCall.params.webhook.receivedAt,
	)

	const otherGithubBody = JSON.stringify({ ref: 'refs/heads/other' })
	const differentBodyReplay = await sendWebhook('github', {
		body: otherGithubBody,
		headers: {
			'x-hub-signature-256': await sign(otherGithubBody),
			'x-github-delivery': 'delivery-abc',
		},
	})
	expect(differentBodyReplay.status).toBe(200)
	expect(await differentBodyReplay.json()).toEqual(firstGithubBody)
	expect(exportMock.exportInvocations).toBe(1)

	expect(
		await statusOf('github', {
			body: githubBody,
			headers: { 'x-hub-signature-256': githubHeaders['x-hub-signature-256'] },
		}),
	).toBe(401)
	expect(exportMock.exportInvocations).toBe(1)
})

test('first-party trusted webhooks accept Idempotency-Key, params mode, and a higher rate limit', async () => {
	const userId = await setupOwnerWithWebhooks([
		'message-created',
		'burst',
		'vendor',
	])
	declareWebhook({
		name: 'message-created',
		responseMode: 'sync',
		inputMode: 'params',
	})
	const exportMock = createHashedIdempotencyExportMock()
	const postMessage = (body: unknown, headers?: Record<string, string>) =>
		sendWebhook('message-created', { body: JSON.stringify(body), headers })

	const envelope = {
		params: { messageId: 'm-1', content: 'hello' },
		idempotencyKey: 'evt-discord-1',
	}
	const first = await postMessage(envelope)
	expect(first.status).toBe(200)
	expect(await first.json()).toEqual({ ok: true, result: { handled: true } })
	expect(exportMock.exportInvocations).toBe(1)
	expect(invoked(0).params).toEqual({ messageId: 'm-1', content: 'hello' })
	expect(invoked(0).idempotencyKey).toBe('evt-discord-1')
	expect(invoked(0).idempotencyParamsHash).toBeUndefined()
	expect(invoked(0).idempotencyHashParams).toBeUndefined()

	const replay = await postMessage(envelope, {
		'Idempotency-Key': 'evt-discord-1',
	})
	expect(replay.status).toBe(200)
	expect(await replay.json()).toMatchObject({
		ok: true,
		result: { handled: true },
		idempotency: { replayed: true },
	})
	expect(exportMock.exportInvocations).toBe(1)

	const mismatch = await postMessage({
		params: { messageId: 'm-1', content: 'different' },
		idempotencyKey: 'evt-discord-1',
	})
	expect(mismatch.status).toBe(409)
	expect(await mismatch.json()).toMatchObject({
		ok: false,
		error: { code: 'idempotency_mismatch' },
	})
	expect(exportMock.exportInvocations).toBe(1)

	mocks.invokePackageExport.mockImplementationOnce(async () => ({
		status: 409,
		body: { ok: false, error: { code: 'invocation_in_progress' } },
	}))
	const inProgress = await postMessage({
		params: { messageId: 'm-9' },
		idempotencyKey: 'evt-in-progress',
	})
	expect(inProgress.status).toBe(409)
	expect(await inProgress.json()).toMatchObject({
		ok: false,
		error: { code: 'invocation_in_progress' },
	})

	const routedBody = {
		route: 'linkedin/register-video-upload',
		dryRun: false,
		params: { fileSizeBytes: 12, confirm: true },
	}
	for (const [directBody, key] of [
		[{ videoId: 'v-1' }, 'evt-direct-1'],
		[routedBody, 'evt-routed-1'],
	] as const) {
		expect(
			(await postMessage(directBody, { 'Idempotency-Key': key })).status,
		).toBe(200)
		expect(invoked(-1).params).toEqual(directBody)
		expect(invoked(-1).idempotencyKey).toBe(key)
	}

	const invalidParams = await postMessage(['not', 'an', 'object'])
	expect(invalidParams.status).toBe(400)
	expect(await invalidParams.json()).toMatchObject({
		ok: false,
		error: { code: 'invalid_params' },
	})

	declareWebhook({
		name: 'burst',
		inputMode: 'params',
		rateLimitPerMinute: 2,
	})
	const burstStatuses = []
	for (const n of [1, 2, 3]) {
		burstStatuses.push(
			await statusOf('burst', {
				body: JSON.stringify({ n }),
				headers: { 'Idempotency-Key': `burst-${n}` },
			}),
		)
	}
	expect(burstStatuses).toEqual([202, 202, 429])
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(enqueued(0).callerIdempotency).toBe(true)

	await mintWebhook({ userId, webhookName: 'retired' })
	const retiredKey = `webhook:user:${userId}:endpoint:mint-retired`
	await checkRateLimit(env.APP_DB, retiredKey, webhookRateLimitConfig)
	const now = Math.floor(Date.now() / 1000)
	await env.APP_DB.batch(
		Array.from({ length: webhookRateLimitConfig.maxRequests - 1 }, () =>
			env.APP_DB.prepare(
				`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`,
			).bind(retiredKey, now),
		),
	)
	expect(await statusOf('retired', { body: JSON.stringify({ n: 1 }) })).toBe(
		429,
	)
	expect(await listDeliveries(userId, 'retired')).toEqual([])

	declareWebhook({
		name: 'vendor',
		responseMode: 'sync',
		verification: githubVerification,
	})
	mockSecretValue(hmacSecret)
	const vendorBody = JSON.stringify({ ref: 'refs/heads/main' })
	expect(
		await statusOf('vendor', {
			body: vendorBody,
			headers: { 'x-hub-signature-256': await sign(vendorBody) },
		}),
	).toBe(200)
	expect(invoked(-1).params.webhook.name).toBe('vendor')
	expect(invoked(-1).params.request.json).toEqual({ ref: 'refs/heads/main' })
})

test('rotate overlap accepts the previous URL until the new URL is used or the grace expires', async () => {
	const userId = await setupOwnerWithWebhooks([])
	const previousSecret = 'previous-url-secret'
	const currentSecret = 'current-url-secret'
	await mintWebhook({
		userId,
		webhookName: 'overlap',
		urlSecret: currentSecret,
		previousUrlSecret: previousSecret,
		previousExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
	})
	const readOverlap = () =>
		env.APP_DB.prepare(
			`SELECT previous_url_secret_hash, previous_url_secret_expires_at
			FROM webhook_endpoints WHERE id = 'mint-overlap'`,
		).first<{
			previous_url_secret_hash: string | null
			previous_url_secret_expires_at: string | null
		}>()

	declareWebhook({ name: 'overlap' })
	expect(await statusOf('overlap', { urlSecret: previousSecret })).toBe(202)
	expect((await readOverlap())?.previous_url_secret_hash).toBeTruthy()

	declareWebhook({ name: 'overlap', verification: githubVerification })
	mockSecretValue(hmacSecret)
	expect(await statusOf('overlap', { urlSecret: currentSecret })).toBe(401)
	expect((await readOverlap())?.previous_url_secret_hash).toBeTruthy()

	const confirmBody = JSON.stringify({ event: 'push' })
	expect(
		await statusOf('overlap', {
			urlSecret: currentSecret,
			body: confirmBody,
			headers: { 'x-hub-signature-256': await sign(confirmBody) },
		}),
	).toBe(202)
	expect(await readOverlap()).toEqual({
		previous_url_secret_hash: null,
		previous_url_secret_expires_at: null,
	})
	expect(await statusOf('overlap', { urlSecret: previousSecret })).toBe(404)

	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await mintWebhook({
		userId,
		webhookName: 'expired',
		urlSecret: currentSecret,
		previousUrlSecret: previousSecret,
		previousExpiresAt: '2026-07-23T00:00:00.000Z',
	})
	declareWebhook({ name: 'expired' })
	expect(await statusOf('expired', { urlSecret: previousSecret })).toBe(404)
	expect(await statusOf('expired', { urlSecret: currentSecret })).toBe(202)
})

test('subscription challenges answer on minted URLs without invoking exports', async () => {
	const userId = await setupOwnerWithWebhooks(['activity-event'])
	const hook = 'activity-event'
	const getChallenge = (query: string) =>
		sendWebhook(hook, { method: 'GET', query })
	const crcQuery = 'crc_token=x-crc-token'
	const crcChallenge = {
		type: 'x-activity-crc',
		secretName: 'xConsumerSecret',
	} as const

	declareWebhook({ name: hook, challenge: crcChallenge })
	mockSecretValue('consumer-secret')
	const crcResponse = await getChallenge(crcQuery)
	expect(crcResponse.status).toBe(200)
	const crcJson = (await crcResponse.json()) as { response_token: string }
	expect(crcJson.response_token).toMatch(/^sha256=/)
	expect(await listDeliveries(userId, hook)).toEqual([])
	mockSecretValue(null)
	expect((await getChallenge(crcQuery)).status).toBe(401)

	declareWebhook({
		name: hook,
		challenge: {
			type: 'slack-url-verification',
			secretName: 'slackSigningSecret',
		},
	})
	const slackBody = JSON.stringify({
		type: 'url_verification',
		challenge: 'slack-challenge',
	})
	mockSecretValue('slack-signing-secret')
	const timestamp = String(Math.floor(Date.now() / 1000))
	const slackOk = await sendWebhook(hook, {
		body: slackBody,
		headers: {
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': await sign(
				`v0:${timestamp}:${slackBody}`,
				'v0=',
				'slack-signing-secret',
			),
		},
	})
	expect(slackOk.status).toBe(200)
	expect(await slackOk.json()).toEqual({ challenge: 'slack-challenge' })
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()

	declareWebhook({ name: hook })
	const noChallengeGet = await getChallenge('crc_token=x')
	expect(noChallengeGet.status).toBe(405)
	expect(noChallengeGet.headers.get('Allow')).toBe('POST')

	await suspendOwner(userId, '2026-07-24T12:00:00.000Z')
	declareWebhook({ name: hook, challenge: crcChallenge })
	mockSecretValue('consumer-secret')
	expect((await getChallenge(crcQuery)).status).toBe(403)
	expect(await listDeliveries(userId, hook)).toEqual([])
})
