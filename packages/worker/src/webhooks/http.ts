import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritable,
} from '#worker/account/deletion-state.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { findPublicUserIdentityByUsername } from '#worker/identity/user-lookup.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { listPackageWebhooks } from '#worker/package-registry/manifest.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	buildWebhookDeliveryIdempotencyKey,
	buildWebhookTimestampBodyPayload,
	isWebhookTimestampWithinTolerance,
	parseWebhookReplayTimestamp,
	providedWebhookHmacValues,
	verifyWebhookHmacSignature,
	webhookUrlSecretMatches,
} from './crypto.ts'
import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import {
	createWebhookDispatchQueueMessage,
	enqueueWebhookDispatch,
	getWebhookDispatchQueueMessageBytes,
	webhookDispatchQueueMessageMaxBytes,
	withSpilledWebhookDispatchPayload,
} from './dispatch-queue-producer.ts'
import {
	deleteWebhookDispatchPayload,
	storeWebhookDispatchPayload,
} from './dispatch-payload-store.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import {
	buildWebhookCallerIdempotencyHashParams,
	buildWebhookExportParams,
	readWebhookCallerIdempotencyKey,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import { getWebhookEndpointByKey } from './repo.ts'
import {
	webhookDefaultReplayToleranceSeconds,
	webhookIdempotencyKeyHeader,
	webhookMaxPayloadBytes,
	webhookRateLimitConfigFor,
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

function tooLargeResponse(maxBytes = webhookMaxPayloadBytes) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message: `Webhook payload exceeds the ${formatPayloadLimitLabel(maxBytes)} limit.`,
			},
		},
		{ status: 413 },
	)
}

function ackQueueMessageTooLargeResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message:
					'Webhook payload is too large for asynchronous delivery (120 KB serialized limit).',
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

function invalidParamsResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_params',
				message:
					'inputMode "params" requires a JSON object body. When the body has a params object, that object is the export argument.',
			},
		},
		{ status: 400 },
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

async function rejectUnauthorizedSignature(input: {
	env: Env
	endpoint: Parameters<typeof recordWebhookDelivery>[0]['endpoint']
	kodyId: string
	error: string
	payloadBytes: number
	startedAt: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	await recordWebhookDelivery({
		env: input.env,
		endpoint: input.endpoint,
		kodyId: input.kodyId,
		outcome: 'rejected',
		httpStatus: 401,
		error: input.error,
		payloadBytes: input.payloadBytes,
		startedAt: input.startedAt,
		waitUntil: input.waitUntil,
	})
	return unauthorizedSignatureResponse()
}

function dispatchUnavailableResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'webhook_dispatch_unavailable',
				message: 'Webhook dispatch is temporarily unavailable. Please retry.',
			},
		},
		{ status: 503 },
	)
}

function waitUntilFrom(ctx?: ExecutionContext) {
	return ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined
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
	const waitUntil = waitUntilFrom(ctx)
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

	const secretMatches = await webhookUrlSecretMatches({
		candidate: route.urlSecret,
		storedHash: endpoint.urlSecretHash,
	})
	// Wrong secret: no delivery row (avoids log-flush DoS) and no rate-limit
	// side channel that would distinguish minted names from unknown ones.
	if (!secretMatches) {
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

	const rateLimit = await checkRateLimit(
		env.APP_DB,
		`webhook:user:${endpoint.userId}:endpoint:${endpoint.id}`,
		webhookRateLimitConfigFor(declared?.rateLimitPerMinute),
	)
	if (!rateLimit.allowed) {
		return rateLimitedResponse(rateLimit.retryAfterSeconds ?? 60)
	}

	// Republished package removed/renamed the webhook → deactivate ingress.
	// Rate-limit first so a minted-but-undeclared URL cannot flush delivery
	// history without bound.
	if (!declared) {
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 404,
			error: 'webhook_not_declared',
			payloadBytes: 0,
			startedAt: receivedAt,
			waitUntil,
		})
		return notFoundResponse()
	}

	try {
		await assertAccountWritable(env, endpoint.userId)
	} catch (error) {
		if (!(error instanceof AccountDeletionInProgressError)) throw error
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 409,
			error: 'account_deleting',
			payloadBytes: 0,
			startedAt: receivedAt,
			waitUntil,
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
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 413,
			error: 'payload_too_large',
			payloadBytes: bodyResult.payloadBytes,
			startedAt: receivedAt,
			waitUntil,
		})
		return bodyResult.response
	}
	const bodyBytes = bodyResult.bytes
	const bodyBuffer = bodyBytes.buffer.slice(
		bodyBytes.byteOffset,
		bodyBytes.byteOffset + bodyBytes.byteLength,
	) as ArrayBuffer
	const bodyText = new TextDecoder().decode(bodyBytes)

	const rejectUnauthorized = (error: string) =>
		rejectUnauthorizedSignature({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			error,
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})

	let replayTimestampToken: string | undefined
	if (declared.replay?.timestampHeader) {
		const timestampFormat = declared.replay.timestampFormat
		if (!timestampFormat) {
			return rejectUnauthorized('invalid_timestamp')
		}
		const parsedTimestamp = parseWebhookReplayTimestamp({
			headerValue: request.headers.get(declared.replay.timestampHeader),
			format: timestampFormat,
		})
		if (!parsedTimestamp.ok) {
			return rejectUnauthorized(
				parsedTimestamp.reason === 'missing'
					? 'missing_timestamp'
					: 'invalid_timestamp',
			)
		}
		const toleranceSeconds =
			declared.replay.toleranceSeconds ?? webhookDefaultReplayToleranceSeconds
		if (
			!isWebhookTimestampWithinTolerance({
				timestampMs: parsedTimestamp.timestampMs,
				nowMs: Date.parse(receivedAt),
				toleranceSeconds,
			})
		) {
			return rejectUnauthorized('timestamp_outside_tolerance')
		}
		replayTimestampToken = parsedTimestamp.timestampToken
	}

	if (declared.replay?.deliveryIdHeader) {
		const deliveryIdValue = request.headers
			.get(declared.replay.deliveryIdHeader)
			?.trim()
		if (!deliveryIdValue) {
			return rejectUnauthorized('missing_delivery_id')
		}
	}

	if (declared.verification) {
		const headerName = declared.verification.header
		const provided = request.headers.get(headerName)
		if (!provided) {
			return rejectUnauthorized('missing_signature')
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
			return rejectUnauthorized(
				`verification_secret_missing:${declared.verification.secretName}`,
			)
		}
		const signedPayload = declared.verification.signedPayload ?? 'body'
		let hmacPayload = bodyBuffer
		if (signedPayload === 'timestamp.body') {
			if (!replayTimestampToken) {
				return rejectUnauthorized('invalid_timestamp')
			}
			hmacPayload = buildWebhookTimestampBodyPayload({
				timestampToken: replayTimestampToken,
				body: bodyBuffer,
			})
		}
		const providedValues = providedWebhookHmacValues({
			provided,
			verificationHeader: headerName,
			timestampHeader: declared.replay?.timestampHeader,
			timestampFormat: declared.replay?.timestampFormat,
		})
		let valid = false
		for (const candidate of providedValues) {
			if (
				await verifyWebhookHmacSignature({
					algorithm: declared.verification.type,
					secret: resolved.value,
					body: hmacPayload,
					encoding: declared.verification.encoding,
					prefix: declared.verification.prefix,
					provided: candidate,
				})
			) {
				valid = true
				break
			}
		}
		if (!valid) {
			return rejectUnauthorized('invalid_signature')
		}
	}

	const extraAllowedHeaders = [
		...(declared.verification ? [declared.verification.header] : []),
		...(declared.replay?.timestampHeader
			? [declared.replay.timestampHeader]
			: []),
		...(declared.replay?.deliveryIdHeader
			? [declared.replay.deliveryIdHeader]
			: []),
		webhookIdempotencyKeyHeader,
	]
	const safeHeaders = collectSafeWebhookHeaders(request, extraAllowedHeaders)
	const requestParams = buildWebhookExportParams({
		packageKodyId: savedPackage.kodyId,
		webhookName: route.webhookName,
		request,
		bodyText,
		receivedAt,
		headers: safeHeaders,
	})
	const paramsMode =
		declared.inputMode === 'params'
			? resolveWebhookParamsModeFirstArg(requestParams.request.json)
			: null
	if (paramsMode && !paramsMode.ok) {
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 400,
			error: 'invalid_params',
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})
		return invalidParamsResponse()
	}
	const exportParams = paramsMode?.ok ? paramsMode.params : requestParams
	const deliveryId = crypto.randomUUID()
	const callerIdempotencyKey = readWebhookCallerIdempotencyKey({
		request,
		json: requestParams.request.json,
		allowBodyKey: declared.inputMode === 'params',
	})
	const providerDeliveryId =
		!callerIdempotencyKey && declared.replay?.deliveryIdHeader
			? request.headers.get(declared.replay.deliveryIdHeader)?.trim()
			: undefined
	const idempotencyKey = callerIdempotencyKey
		? callerIdempotencyKey
		: providerDeliveryId
			? await buildWebhookDeliveryIdempotencyKey({
					userId: endpoint.userId,
					packageId: endpoint.packageId,
					webhookName: endpoint.webhookName,
					deliveryId: providerDeliveryId,
				})
			: `webhook:${endpoint.id}:${deliveryId}`
	// Delivery-id keys identify the event, not the HTTP attempt. Provider
	// retries change `receivedAt` and often headers; the same delivery id is
	// still that event even when body bytes differ. Matching the ledger by
	// key alone (`idempotencyParamsHash: 'ignore'`) returns the original
	// acknowledgement instead of hashing those volatile fields. A different
	// delivery id cannot reuse another event's ack because the key already
	// binds userId + packageId + webhookName + deliveryId.
	//
	// Caller Idempotency-Key (and params-mode JSON idempotencyKey) use the
	// standard include-hash ledger: same key + same payload replays; a
	// different payload is 409. Request-mode caller keys hash the JSON body
	// (not the envelope) so receivedAt does not break retries.
	const idempotencyParamsHash = providerDeliveryId
		? ('ignore' as const)
		: undefined
	const idempotencyHashParams =
		callerIdempotencyKey && declared.inputMode !== 'params'
			? buildWebhookCallerIdempotencyHashParams({
					json: requestParams.request.json,
					bodyText,
				})
			: undefined

	if (declared.responseMode === 'ack') {
		let message = createWebhookDispatchQueueMessage({
			endpoint: {
				id: endpoint.id,
				userId: endpoint.userId,
				packageId: endpoint.packageId,
				webhookName: endpoint.webhookName,
			},
			packageKodyId: savedPackage.kodyId,
			exportName: declared.exportName,
			params: requestParams,
			...(declared.inputMode === 'params'
				? { inputMode: 'params' as const }
				: {}),
			idempotencyKey,
			...(idempotencyParamsHash ? { idempotencyParamsHash } : {}),
			...(callerIdempotencyKey ? { callerIdempotency: true as const } : {}),
			deliveryId,
			payloadBytes: bodyBytes.byteLength,
			receivedAt,
		})
		if (
			getWebhookDispatchQueueMessageBytes(message) >
			webhookDispatchQueueMessageMaxBytes
		) {
			try {
				const payloadKvKey = await storeWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					userId: endpoint.userId,
					deliveryId,
					body: bodyText,
				})
				message = withSpilledWebhookDispatchPayload(message, payloadKvKey)
			} catch (error) {
				console.error('webhook-dispatch-payload-store-failed', {
					endpointId: endpoint.id,
					error,
				})
				return dispatchUnavailableResponse()
			}
		}
		if (
			getWebhookDispatchQueueMessageBytes(message) >
			webhookDispatchQueueMessageMaxBytes
		) {
			if (message.payloadKvKey) {
				await deleteWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					key: message.payloadKvKey,
				}).catch((error) => {
					console.error('webhook-dispatch-payload-delete-failed', {
						endpointId: endpoint.id,
						error,
					})
				})
			}
			await recordWebhookDelivery({
				env,
				endpoint,
				kodyId: savedPackage.kodyId,
				outcome: 'rejected',
				httpStatus: 413,
				error: 'payload_too_large_for_ack_queue',
				payloadBytes: bodyBytes.byteLength,
				invocationId: deliveryId,
				startedAt: receivedAt,
				waitUntil,
			})
			return ackQueueMessageTooLargeResponse()
		}
		try {
			await enqueueWebhookDispatch({
				queue: env.WEBHOOK_DISPATCH_QUEUE,
				message,
			})
		} catch (error) {
			if (message.payloadKvKey) {
				await deleteWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					key: message.payloadKvKey,
				}).catch((error) => {
					console.error('webhook-dispatch-payload-delete-failed', {
						endpointId: endpoint.id,
						error,
					})
				})
			}
			console.error('webhook-dispatch-enqueue-failed', {
				endpointId: endpoint.id,
				error,
			})
			return dispatchUnavailableResponse()
		}
		return jsonResponse({ ok: true }, { status: 202 })
	}

	try {
		const response = await runWithTimeout(
			dispatchWebhookInvocation({
				env,
				baseUrl,
				endpoint,
				packageKodyId: savedPackage.kodyId,
				exportName: declared.exportName,
				params: exportParams,
				idempotencyKey,
				...(idempotencyParamsHash ? { idempotencyParamsHash } : {}),
				...(idempotencyHashParams ? { idempotencyHashParams } : {}),
			}),
			webhookSyncInvocationTimeoutMs,
		)
		if (response.status === 409) {
			await recordWebhookDelivery({
				env,
				endpoint,
				kodyId: savedPackage.kodyId,
				outcome: 'rejected',
				httpStatus: 409,
				error: `invocation_status_409`,
				payloadBytes: bodyBytes.byteLength,
				invocationId: deliveryId,
				result: readWebhookInvocationResult(response.body),
				startedAt: receivedAt,
				waitUntil,
			})
			return jsonResponse(response.body, { status: 409 })
		}
		const ok = response.status >= 200 && response.status < 300
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: ok ? 'delivered' : 'failed',
			httpStatus: ok ? response.status : 502,
			error: ok ? null : `invocation_status_${response.status}`,
			payloadBytes: bodyBytes.byteLength,
			invocationId: deliveryId,
			result: readWebhookInvocationResult(response.body),
			startedAt: receivedAt,
			waitUntil,
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
		await recordWebhookDelivery({
			env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'failed',
			httpStatus: 502,
			error: error instanceof Error ? error.message : 'invocation_failed',
			payloadBytes: bodyBytes.byteLength,
			invocationId: deliveryId,
			startedAt: receivedAt,
			waitUntil,
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
