import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritable,
} from '#app/account-deletion-state.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { listPackageWebhooks } from '#worker/package-registry/manifest.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { listAttachedRemoteConnectorRefs } from '#worker/remote-connector/settings-service.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import {
	webhookUrlSecretMatches,
	verifyWebhookHmacSignature,
} from './crypto.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import { getWebhookEndpointByKey, insertWebhookDelivery } from './repo.ts'
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
		parts.length !== 5 ||
		!parts[0]?.startsWith('@') ||
		parts[0].length <= 1 ||
		parts[1] !== 'webhooks'
	) {
		return null
	}
	const username = decodePathComponent(parts[0].slice(1))
	const packageKodyId = decodePathComponent(parts[2] ?? '')
	const webhookName = decodePathComponent(parts[3] ?? '')
	const urlSecret = decodePathComponent(parts[4] ?? '')
	if (!username || !packageKodyId || !webhookName || !urlSecret) return null
	return { username, packageKodyId, webhookName, urlSecret }
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

function formatPayloadLimitLabel(maxBytes: number) {
	const megabytes = maxBytes / (1024 * 1024)
	if (Number.isInteger(megabytes)) return `${megabytes} MB`
	return `${maxBytes} bytes`
}

function tooLargeResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message: `Webhook payload exceeds the ${formatPayloadLimitLabel(webhookMaxPayloadBytes)} limit.`,
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
			packageId: input.endpoint.packageId,
			webhookName: input.endpoint.webhookName,
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
	packageKodyId: string
	webhookName: string
	request: Request
	bodyText: string
	receivedAt: string
	headers: Record<string, string>
}): WebhookExportParams {
	return {
		webhook: {
			packageKodyId: input.packageKodyId,
			name: input.webhookName,
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
	packageKodyId: string
	exportName: string
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
			displayName: `webhook:${input.packageKodyId}:${input.endpoint.webhookName}`,
			packageIds: [input.endpoint.packageId],
			packageKodyIds: [input.packageKodyId],
			exportNames: [input.exportName],
			sources: ['webhook'],
			remoteConnectors,
		},
		request: {
			packageIdOrKodyId: input.endpoint.packageId,
			exportName: input.exportName,
			params: input.params,
			idempotencyKey: input.idempotencyKey,
			source: 'webhook',
			topic: `webhook:${input.packageKodyId}:${input.endpoint.webhookName}`,
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
	const routeUser = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: route.username,
	})
	if (!routeUser) return notFoundResponse()

	const savedPackage = await getSavedPackageByKodyId(env.APP_DB, {
		userId: routeUser.mcpUserId,
		kodyId: route.packageKodyId,
	})
	if (!savedPackage) return notFoundResponse()

	const endpoint = await getWebhookEndpointByKey({
		db: env.APP_DB,
		userId: routeUser.mcpUserId,
		packageId: savedPackage.id,
		webhookName: route.webhookName,
	})
	// Unminted, disabled, or unknown name → indistinguishable 404.
	if (!endpoint || !endpoint.enabled) {
		return notFoundResponse()
	}

	// Bound every subsequent delivery-log write (including pre-auth rejects).
	const rateLimit = await checkRateLimit(
		env.APP_DB,
		`webhook:endpoint:${endpoint.id}`,
		webhookRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		return rateLimitedResponse(rateLimit.retryAfterSeconds ?? 60)
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

	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	let declared
	try {
		const loaded = await loadPackageManifestBySourceId({
			env,
			baseUrl,
			userId: routeUser.mcpUserId,
			sourceId: savedPackage.sourceId,
		})
		declared = listPackageWebhooks(loaded.manifest).find(
			(webhook) => webhook.name === route.webhookName,
		)
	} catch {
		declared = undefined
	}
	// Republished package removed/renamed the webhook → deactivate ingress.
	if (!declared) {
		await recordDelivery({
			db: env.APP_DB,
			endpoint,
			outcome: 'rejected',
			httpStatus: 404,
			error: 'webhook_not_declared',
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

	if (declared.verification) {
		const headerName = declared.verification.header
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
		const resolved = await resolveSecret({
			env,
			userId: endpoint.userId,
			name: declared.verification.secretName,
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: endpoint.packageId,
			},
		})
		if (!resolved.found || !resolved.value) {
			await recordDelivery({
				db: env.APP_DB,
				endpoint,
				outcome: 'rejected',
				httpStatus: 401,
				error: `verification_secret_missing:${declared.verification.secretName}`,
				payloadBytes: bodyBytes.byteLength,
				receivedAt,
			})
			return unauthorizedSignatureResponse()
		}
		const valid = await verifyWebhookHmacSignature({
			algorithm: declared.verification.type,
			secret: resolved.value,
			body: bodyBuffer,
			encoding: declared.verification.encoding,
			prefix: declared.verification.prefix,
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
		declared.verification ? [declared.verification.header] : [],
	)
	const params = buildExportParams({
		packageKodyId: savedPackage.kodyId,
		webhookName: route.webhookName,
		request,
		bodyText,
		receivedAt,
		headers: safeHeaders,
	})
	const deliveryId = crypto.randomUUID()
	const idempotencyKey = `webhook:${endpoint.id}:${deliveryId}`

	if (declared.responseMode === 'ack') {
		const ackResponse = jsonResponse({ ok: true }, { status: 202 })
		const invokePromise = (async () => {
			try {
				const response = await dispatchWebhookInvocation({
					env,
					baseUrl,
					endpoint,
					packageKodyId: savedPackage.kodyId,
					exportName: declared.exportName,
					params,
					idempotencyKey,
				})
				const ok = response.status >= 200 && response.status < 300
				await insertWebhookDelivery({
					db: env.APP_DB,
					id: deliveryId,
					endpointId: endpoint.id,
					userId: endpoint.userId,
					packageId: endpoint.packageId,
					webhookName: endpoint.webhookName,
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
					packageId: endpoint.packageId,
					webhookName: endpoint.webhookName,
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
				packageKodyId: savedPackage.kodyId,
				exportName: declared.exportName,
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
			packageId: endpoint.packageId,
			webhookName: endpoint.webhookName,
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
			packageId: endpoint.packageId,
			webhookName: endpoint.webhookName,
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
