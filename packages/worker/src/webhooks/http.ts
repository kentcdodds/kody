import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritable,
} from '#app/account-deletion-state.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { listAttachedRemoteConnectorRefs } from '#worker/remote-connector/settings-service.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import {
	webhookUrlSecretMatches,
	verifyWebhookHmacSignature,
} from './crypto.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import { getWebhookEndpointById, insertWebhookDelivery } from './repo.ts'
import { decryptWebhookVerificationSecret } from './verification.ts'
import {
	type WebhookDeliveryOutcome,
	type WebhookEndpointRecord,
	type WebhookExportParams,
	webhookMaxPayloadBytes,
	webhookRateLimitConfig,
	webhookSyncInvocationTimeoutMs,
} from './types.ts'

function decodePathComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

export function parseWebhookIngressPath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	if (
		parts.length !== 4 ||
		!parts[0]?.startsWith('@') ||
		parts[0].length <= 1 ||
		parts[1] !== 'webhooks'
	) {
		return null
	}
	const username = decodePathComponent(parts[0].slice(1))
	const endpointId = decodePathComponent(parts[2] ?? '')
	const urlSecret = decodePathComponent(parts[3] ?? '')
	if (!username || !endpointId || !urlSecret) return null
	return { username, endpointId, urlSecret }
}

export function isWebhookIngressRequest(pathname: string) {
	return parseWebhookIngressPath(pathname) !== null
}

function notFoundResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'not_found',
				message: 'Not found.',
			},
		},
		{ status: 404 },
	)
}

function tooLargeResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message: 'Webhook payload exceeds the 1 MB limit.',
			},
		},
		{ status: 413 },
	)
}

function rateLimitedResponse(retryAfterSeconds: number) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'rate_limited',
				message: 'Too many webhook requests for this endpoint.',
			},
		},
		{
			status: 429,
			headers: {
				'Retry-After': String(retryAfterSeconds),
			},
		},
	)
}

function unauthorizedSignatureResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_signature',
				message: 'Webhook signature verification failed.',
			},
		},
		{ status: 401 },
	)
}

async function recordDelivery(input: {
	db: D1Database
	endpoint: WebhookEndpointRecord
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error?: string | null
	payloadBytes: number
	receivedAt: string
}) {
	try {
		await insertWebhookDelivery({
			db: input.db,
			id: crypto.randomUUID(),
			endpointId: input.endpoint.id,
			userId: input.endpoint.userId,
			receivedAt: input.receivedAt,
			outcome: input.outcome,
			httpStatus: input.httpStatus,
			error: input.error,
			payloadBytes: input.payloadBytes,
		})
	} catch (error) {
		console.error('[webhooks] failed to record delivery', error)
	}
}

async function readBodyWithCap(
	request: Request,
	maxBytes: number,
): Promise<
	| { ok: true; bytes: Uint8Array }
	| { ok: false; response: Response; payloadBytes: number }
> {
	const contentLengthHeader = request.headers.get('content-length')
	if (contentLengthHeader) {
		const contentLength = Number(contentLengthHeader)
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			return {
				ok: false,
				response: tooLargeResponse(),
				payloadBytes: contentLength,
			}
		}
	}
	const buffer = await request.arrayBuffer()
	if (buffer.byteLength > maxBytes) {
		return {
			ok: false,
			response: tooLargeResponse(),
			payloadBytes: buffer.byteLength,
		}
	}
	return { ok: true, bytes: new Uint8Array(buffer) }
}

function parseJsonBody(text: string): unknown | null {
	const trimmed = text.trim()
	if (!trimmed) return null
	try {
		return JSON.parse(trimmed) as unknown
	} catch {
		return null
	}
}

function buildExportParams(input: {
	endpoint: WebhookEndpointRecord
	request: Request
	bodyText: string
	receivedAt: string
	headers: Record<string, string>
}): WebhookExportParams {
	return {
		webhook: {
			endpointId: input.endpoint.id,
			name: input.endpoint.name,
			receivedAt: input.receivedAt,
		},
		request: {
			method: input.request.method,
			contentType: input.request.headers.get('content-type'),
			headers: input.headers,
			body: input.bodyText,
			json: parseJsonBody(input.bodyText),
		},
	}
}

async function dispatchWebhookInvocation(input: {
	env: Env
	baseUrl: string
	endpoint: WebhookEndpointRecord
	params: WebhookExportParams
	idempotencyKey: string
}) {
	const remoteConnectors = await listAttachedRemoteConnectorRefs({
		env: input.env,
		userId: input.endpoint.userId,
	})
	return invokePackageExport({
		env: input.env,
		baseUrl: input.baseUrl,
		token: {
			tokenId: `internal:webhook:${input.endpoint.id}`,
			userId: input.endpoint.userId,
			email: '',
			displayName: `webhook:${input.endpoint.name}`,
			packageIds: [input.endpoint.packageId],
			exportNames: [input.endpoint.exportName],
			sources: ['webhook'],
			remoteConnectors,
		},
		request: {
			packageIdOrKodyId: input.endpoint.packageId,
			exportName: input.endpoint.exportName,
			params: input.params,
			idempotencyKey: input.idempotencyKey,
			source: 'webhook',
			topic: `webhook:${input.endpoint.id}`,
		},
	})
}

async function runWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error('Webhook sync invocation timed out.'))
				}, timeoutMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

export async function handleWebhookIngressRequest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
) {
	const pathname = new URL(request.url).pathname
	const route = parseWebhookIngressPath(pathname)
	if (!route) return notFoundResponse()
	if (request.method !== 'POST') {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'method_not_allowed',
					message: 'Method not allowed.',
				},
			},
			{ status: 405, headers: { Allow: 'POST' } },
		)
	}

	const receivedAt = new Date().toISOString()
	const endpoint = await getWebhookEndpointById({
		db: env.APP_DB,
		endpointId: route.endpointId,
	})
	if (!endpoint || !endpoint.enabled) {
		return notFoundResponse()
	}

	const routeUser = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: route.username,
	})
	if (!routeUser || routeUser.mcpUserId !== endpoint.userId) {
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 404,
			error: 'username_mismatch',
			payloadBytes: 0,
			receivedAt,
		})
		return notFoundResponse()
	}

	const secretMatches = await webhookUrlSecretMatches({
		candidate: route.urlSecret,
		storedHash: endpoint.urlSecretHash,
	})
	if (!secretMatches) {
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 404,
			error: 'url_secret_mismatch',
			payloadBytes: 0,
			receivedAt,
		})
		return notFoundResponse()
	}

	try {
		await assertAccountWritable(env, endpoint.userId)
	} catch (error) {
		if (!(error instanceof AccountDeletionInProgressError)) throw error
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 409,
			error: 'account_deleting',
			payloadBytes: 0,
			receivedAt,
		})
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'account_deleting',
					message: error.message,
				},
			},
			{ status: 409 },
		)
	}

	const rateLimit = await checkRateLimit(
		env.APP_DB,
		`webhook:endpoint:${endpoint.id}`,
		webhookRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 429,
			error: 'rate_limited',
			payloadBytes: 0,
			receivedAt,
		})
		return rateLimitedResponse(rateLimit.retryAfterSeconds ?? 60)
	}

	const bodyResult = await readBodyWithCap(request, webhookMaxPayloadBytes)
	if (!bodyResult.ok) {
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 413,
			error: 'payload_too_large',
			payloadBytes: bodyResult.payloadBytes,
			receivedAt,
		})
		return bodyResult.response
	}
	const bodyBytes = bodyResult.bytes
	const bodyBuffer = bodyBytes.buffer.slice(
		bodyBytes.byteOffset,
		bodyBytes.byteOffset + bodyBytes.byteLength,
	) as ArrayBuffer
	const bodyText = new TextDecoder().decode(bodyBytes)

	if (endpoint.verificationConfig) {
		const headerName = endpoint.verificationConfig.header
		const provided = request.headers.get(headerName)
		if (!provided) {
			await recordDelivery({
				db: env.APP_DB,
				endpoint,
				outcome: 'rejected',
				httpStatus: 401,
				error: 'missing_signature',
				payloadBytes: bodyBytes.byteLength,
				receivedAt,
			})
			return unauthorizedSignatureResponse()
		}
		let secret: string
		try {
			secret = await decryptWebhookVerificationSecret(
				env,
				endpoint.verificationConfig,
			)
		} catch {
			await recordDelivery({
				db: env.APP_DB,
				endpoint,
				outcome: 'failed',
				httpStatus: 500,
				error: 'verification_secret_decrypt_failed',
				payloadBytes: bodyBytes.byteLength,
				receivedAt,
			})
			return jsonResponse(
				{
					ok: false,
					error: {
						code: 'internal_error',
						message: 'Unable to verify webhook signature.',
					},
				},
				{ status: 500 },
			)
		}
		const valid = await verifyWebhookHmacSignature({
			algorithm: endpoint.verificationConfig.type,
			secret,
			body: bodyBuffer,
			encoding: endpoint.verificationConfig.encoding,
			prefix: endpoint.verificationConfig.prefix,
			provided,
		})
		if (!valid) {
			await recordDelivery({
				db: env.APP_DB,
				endpoint,
				outcome: 'rejected',
				httpStatus: 401,
				error: 'invalid_signature',
				payloadBytes: bodyBytes.byteLength,
				receivedAt,
			})
			return unauthorizedSignatureResponse()
		}
	}

	const safeHeaders = collectSafeWebhookHeaders(
		request,
		endpoint.verificationConfig ? [endpoint.verificationConfig.header] : [],
	)
	const params = buildExportParams({
		endpoint,
		request,
		bodyText,
		receivedAt,
		headers: safeHeaders,
	})
	const deliveryId = crypto.randomUUID()
	const idempotencyKey = `webhook:${endpoint.id}:${deliveryId}`
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })

	if (endpoint.responseMode === 'ack') {
		const ackResponse = jsonResponse({ ok: true }, { status: 202 })
		const invokePromise = (async () => {
			try {
				const response = await dispatchWebhookInvocation({
					env,
					baseUrl,
					endpoint,
					params,
					idempotencyKey,
				})
				const ok = response.status >= 200 && response.status < 300
				await insertWebhookDelivery({
					db: env.APP_DB,
					id: deliveryId,
					endpointId: endpoint.id,
					userId: endpoint.userId,
					receivedAt,
					outcome: ok ? 'delivered' : 'failed',
					httpStatus: ok ? 202 : 502,
					error: ok ? null : `invocation_status_${response.status}`,
					payloadBytes: bodyBytes.byteLength,
				})
			} catch (error) {
				await insertWebhookDelivery({
					db: env.APP_DB,
					id: deliveryId,
					endpointId: endpoint.id,
					userId: endpoint.userId,
					receivedAt,
					outcome: 'failed',
					httpStatus: 502,
					error: error instanceof Error ? error.message : 'invocation_failed',
					payloadBytes: bodyBytes.byteLength,
				})
			}
		})()
		if (ctx) {
			ctx.waitUntil(invokePromise)
		} else {
			void invokePromise
		}
		return ackResponse
	}

	try {
		const response = await runWithTimeout(
			dispatchWebhookInvocation({
				env,
				baseUrl,
				endpoint,
				params,
				idempotencyKey,
			}),
			webhookSyncInvocationTimeoutMs,
		)
		const ok = response.status >= 200 && response.status < 300
		await insertWebhookDelivery({
			db: env.APP_DB,
			id: deliveryId,
			endpointId: endpoint.id,
			userId: endpoint.userId,
			receivedAt,
			outcome: ok ? 'delivered' : 'failed',
			httpStatus: ok ? response.status : 502,
			error: ok ? null : `invocation_status_${response.status}`,
			payloadBytes: bodyBytes.byteLength,
		})
		if (!ok) {
			return jsonResponse(
				{
					ok: false,
					error: {
						code: 'invocation_failed',
						message: 'Bound package export invocation failed.',
					},
				},
				{ status: 502 },
			)
		}
		return jsonResponse(response.body, { status: response.status })
	} catch (error) {
		await insertWebhookDelivery({
			db: env.APP_DB,
			id: deliveryId,
			endpointId: endpoint.id,
			userId: endpoint.userId,
			receivedAt,
			outcome: 'failed',
			httpStatus: 502,
			error: error instanceof Error ? error.message : 'invocation_failed',
			payloadBytes: bodyBytes.byteLength,
		})
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'invocation_failed',
					message: 'Bound package export invocation failed.',
				},
			},
			{ status: 502 },
		)
	}
}
