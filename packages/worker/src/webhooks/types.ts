import {
	webhookDefaultRateLimitPerMinute as defaultRateLimitPerMinute,
	webhookMaxRateLimitPerMinute as maxRateLimitPerMinute,
} from '#worker/package-registry/types.ts'

export type WebhookResponseMode = 'ack' | 'sync'

export type WebhookInputMode = 'request' | 'params'

export type WebhookHmacAlgorithm = 'hmac-sha256' | 'hmac-sha1'

export type WebhookSignatureEncoding = 'hex' | 'base64'

export type WebhookSignedPayload = 'body' | 'timestamp.body'

export type WebhookTimestampFormat =
	| 'unix-seconds'
	| 'unix-millis'
	| 'iso-8601'
	| 'stripe-signature'

export type WebhookVerificationConfig = {
	type: WebhookHmacAlgorithm
	header: string
	secretName: string
	encoding: WebhookSignatureEncoding
	prefix?: string
	signedPayload?: WebhookSignedPayload
}

export type WebhookReplayConfig = {
	timestampHeader?: string
	timestampFormat?: WebhookTimestampFormat
	toleranceSeconds?: number
	deliveryIdHeader?: string
}

export const webhookDefaultReplayToleranceSeconds = 300

/** Minted URL state for a declared package webhook. */
export type WebhookEndpointRecord = {
	id: string
	userId: string
	packageId: string
	webhookName: string
	urlSecretHash: string
	urlSecretEncrypted: string | null
	previousUrlSecretHash: string | null
	previousUrlSecretExpiresAt: string | null
	enabled: boolean
	createdAt: string
	rotatedAt: string
}

/**
 * Rotate overlap fallback. Ack-queue spilled payloads already live for 24h
 * (`webhookDispatchPayloadTtlSeconds`); GitHub-style provider retries cover
 * about the same window. The first accepted POST on the new URL retires the
 * previous secret earlier.
 */
export const webhookUrlRotationGraceMs = 24 * 60 * 60 * 1000

export function webhookUrlRotationGraceExpiresAt(now: Date | string) {
	const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
	return new Date(nowMs + webhookUrlRotationGraceMs).toISOString()
}

export function isWebhookPreviousUrlLive(
	endpoint: {
		previousUrlSecretHash: string | null
		previousUrlSecretExpiresAt: string | null
	},
	now: Date | string = new Date(),
) {
	if (!endpoint.previousUrlSecretHash || !endpoint.previousUrlSecretExpiresAt) {
		return false
	}
	const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
	return Date.parse(endpoint.previousUrlSecretExpiresAt) > nowMs
}

export type WebhookDeliveryOutcome = 'delivered' | 'rejected' | 'failed'

export type WebhookDeliveryRecord = {
	id: string
	endpointId: string
	userId: string
	packageId: string
	webhookName: string
	receivedAt: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error: string | null
	payloadBytes: number
}

export type WebhookExportParams = {
	webhook: {
		packageKodyId: string
		name: string
		receivedAt: string
	}
	request: {
		method: string
		contentType: string | null
		headers: Record<string, string>
		body: string
		json: unknown | null
	}
}

export const webhookMaxPayloadBytes = 1 * 1024 * 1024
export const webhookDeliveriesRetainedPerEndpoint = 50
export const webhookDefaultRateLimitPerMinute = defaultRateLimitPerMinute
export const webhookMaxRateLimitPerMinute = maxRateLimitPerMinute
export const webhookRateLimitWindowSeconds = 60
export const webhookRateLimitConfig = {
	maxRequests: webhookDefaultRateLimitPerMinute,
	windowSeconds: webhookRateLimitWindowSeconds,
} as const
export const webhookIdempotencyKeyHeader = 'Idempotency-Key'

export function webhookRateLimitConfigFor(perMinute?: number) {
	return {
		maxRequests: perMinute ?? webhookDefaultRateLimitPerMinute,
		windowSeconds: webhookRateLimitWindowSeconds,
	}
}
export const webhookSyncInvocationTimeoutMs = 30_000
export const webhookDeliveryErrorMaxLength = 500
