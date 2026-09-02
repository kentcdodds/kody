export type WebhookResponseMode = 'ack' | 'sync'

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
	enabled: boolean
	createdAt: string
	rotatedAt: string
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
export const webhookRateLimitConfig = {
	maxRequests: 60,
	windowSeconds: 60,
} as const
export const webhookSyncInvocationTimeoutMs = 30_000
export const webhookDeliveryErrorMaxLength = 500
