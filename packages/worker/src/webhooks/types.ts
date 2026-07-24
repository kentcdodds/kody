export type WebhookResponseMode = 'ack' | 'sync'

export type WebhookHmacAlgorithm = 'hmac-sha256' | 'hmac-sha1'

export type WebhookSignatureEncoding = 'hex' | 'base64'

/** Caller-facing verification config (plaintext secret, create/update only). */
export type WebhookVerificationInput = {
	type: WebhookHmacAlgorithm
	header: string
	secret: string
	encoding: WebhookSignatureEncoding
	prefix?: string
}

/** Stored verification config; secret is encrypted at rest. */
export type StoredWebhookVerificationConfig = {
	type: WebhookHmacAlgorithm
	header: string
	encoding: WebhookSignatureEncoding
	prefix?: string
	encryptedSecret: string
}

/** Public view of verification config (never includes the secret). */
export type PublicWebhookVerificationConfig = {
	type: WebhookHmacAlgorithm
	header: string
	encoding: WebhookSignatureEncoding
	prefix?: string
}

export type WebhookEndpointRecord = {
	id: string
	userId: string
	name: string
	packageId: string
	exportName: string
	urlSecretHash: string
	verificationConfig: StoredWebhookVerificationConfig | null
	responseMode: WebhookResponseMode
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type WebhookDeliveryOutcome = 'delivered' | 'rejected' | 'failed'

export type WebhookDeliveryRecord = {
	id: string
	endpointId: string
	userId: string
	receivedAt: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error: string | null
	payloadBytes: number
}

export type WebhookExportParams = {
	webhook: {
		endpointId: string
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
