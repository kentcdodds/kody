import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import {
	mcpEventDeliveryRetryDelaysMs,
	mcpEventPayloadMaxBytes,
	type McpEventDeliveryErrorCategory,
} from './constants.ts'
import { buildSignedWebhookHeaders } from './signing.ts'
import { fetchMcpEventCallback, McpEventCallbackUrlError } from './ssrf.ts'

/** Webhook body for one event (draft `EventOccurrence`). */
export type McpEventOccurrence = {
	eventId: string
	name: string
	timestamp: string
	data: Record<string, unknown>
	/** Package events have no replay, so the watermark is always null. */
	cursor: null
}

type CallbackAttemptResult =
	| { ok: true; response: Response }
	| {
			ok: false
			error: McpEventDeliveryErrorCategory
			retryable: boolean
	  }

export class McpEventCallbackVerificationError extends Error {
	readonly reason: McpEventDeliveryErrorCategory
	constructor(reason: McpEventDeliveryErrorCategory) {
		super(`Callback endpoint verification failed: ${reason}.`)
		this.name = 'McpEventCallbackVerificationError'
		this.reason = reason
	}
}

/**
 * Stable across queue redeliveries and fan-out retries so receivers can
 * dedupe on `webhook-id`: derived from the emitting package and the
 * emitter's idempotency key.
 */
export async function buildMcpEventId(input: {
	sourcePackageId: string
	topic: string
	idempotencyKey: string
}): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJsonStringify(input)),
	)
	return `evt_${toHex(new Uint8Array(digest)).slice(0, 32)}`
}

export function serializeMcpEventOccurrence(
	occurrence: McpEventOccurrence,
): string {
	const body = JSON.stringify(occurrence)
	const bytes = new TextEncoder().encode(body).byteLength
	if (bytes > mcpEventPayloadMaxBytes) {
		throw new Error(
			`MCP event ${occurrence.name} body is ${bytes} bytes; the webhook maximum is ${mcpEventPayloadMaxBytes} bytes.`,
		)
	}
	return body
}

function categorizeFetchError(error: unknown): CallbackAttemptResult {
	if (error instanceof McpEventCallbackUrlError) {
		return { ok: false, error: 'connection_refused', retryable: false }
	}
	const name = error instanceof Error ? error.name : ''
	if (name === 'TimeoutError' || name === 'AbortError') {
		return { ok: false, error: 'timeout', retryable: true }
	}
	const message = error instanceof Error ? error.message : String(error)
	if (/tls|ssl|certificate/i.test(message)) {
		return { ok: false, error: 'tls_error', retryable: true }
	}
	return { ok: false, error: 'connection_refused', retryable: true }
}

async function postSignedCallback(input: {
	url: string
	subscriptionId: string
	webhookId: string
	body: string
	secrets: ReadonlyArray<string>
}): Promise<CallbackAttemptResult> {
	// Fresh timestamp + signature per attempt so retries pass the receiver's
	// freshness window.
	const headers = await buildSignedWebhookHeaders({
		secrets: input.secrets,
		webhookId: input.webhookId,
		subscriptionId: input.subscriptionId,
		body: input.body,
	})
	let response: Response
	try {
		response = await fetchMcpEventCallback(input.url, {
			headers,
			body: input.body,
		})
	} catch (error) {
		return categorizeFetchError(error)
	}
	if (response.status >= 200 && response.status < 300) {
		return { ok: true, response }
	}
	await response.body?.cancel()
	if (response.status === 410 || response.status === 413) {
		return { ok: false, error: 'http_4xx', retryable: false }
	}
	return {
		ok: false,
		error: response.status >= 500 ? 'http_5xx' : 'http_4xx',
		retryable: true,
	}
}

export type McpEventDeliveryResult =
	| { ok: true; attempts: number }
	| { ok: false; attempts: number; error: McpEventDeliveryErrorCategory }

/**
 * POST one signed occurrence with bounded exponential backoff. 410 and 413
 * end the attempt loop for this event (the subscription is unaffected).
 */
export async function deliverMcpEventOccurrence(input: {
	subscriptionId: string
	callbackUrl: string
	secrets: ReadonlyArray<string>
	occurrence: McpEventOccurrence
	body?: string
}): Promise<McpEventDeliveryResult> {
	const body = input.body ?? serializeMcpEventOccurrence(input.occurrence)
	let attempts = 0
	let lastError: McpEventDeliveryErrorCategory = 'connection_refused'
	for (
		let attempt = 0;
		attempt <= mcpEventDeliveryRetryDelaysMs.length;
		attempt++
	) {
		if (attempt > 0) {
			await new Promise((resolve) =>
				setTimeout(resolve, mcpEventDeliveryRetryDelaysMs[attempt - 1]),
			)
		}
		attempts += 1
		const result = await postSignedCallback({
			url: input.callbackUrl,
			subscriptionId: input.subscriptionId,
			webhookId: input.occurrence.eventId,
			body,
			secrets: input.secrets,
		})
		if (result.ok) {
			await result.response.body?.cancel()
			return { ok: true, attempts }
		}
		lastError = result.error
		if (!result.retryable) break
	}
	return { ok: false, attempts, error: lastError }
}

/**
 * Anti-flooding handshake before activating delivery: POST a signed
 * `verification` envelope with a single-use challenge and require a 2xx
 * echo, compared in constant time. Throws
 * {@link McpEventCallbackVerificationError} with a draft `lastError`
 * category; raw endpoint responses never leave this function.
 */
export async function verifyMcpEventCallback(input: {
	callbackUrl: string
	subscriptionId: string
	secret: string
}): Promise<void> {
	const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
	const result = await postSignedCallback({
		url: input.callbackUrl,
		subscriptionId: input.subscriptionId,
		webhookId: `msg_verification_${crypto.randomUUID()}`,
		body: JSON.stringify({ type: 'verification', challenge }),
		secrets: [input.secret],
	})
	if (!result.ok) {
		throw new McpEventCallbackVerificationError(result.error)
	}
	let echoed: unknown
	try {
		echoed = ((await result.response.json()) as { challenge?: unknown })
			?.challenge
	} catch {
		throw new McpEventCallbackVerificationError('challenge_failed')
	}
	if (
		typeof echoed !== 'string' ||
		!(await timingSafeEqualString(echoed, challenge))
	) {
		throw new McpEventCallbackVerificationError('challenge_failed')
	}
}
