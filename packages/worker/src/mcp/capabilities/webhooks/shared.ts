import { z } from 'zod'

export const webhookPackageRefSchema = {
	packageId: z
		.string()
		.min(1)
		.optional()
		.describe('Saved package_id. Prefer this over the package name leaf.'),
	kodyId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Package name leaf or `@owner/leaf`. Prefer packageId when you have the UUID.',
		),
}

export const webhookVerificationPublicSchema = z
	.object({
		type: z.enum(['hmac-sha256', 'hmac-sha1']),
		header: z.string(),
		secretName: z.string(),
		encoding: z.enum(['hex', 'base64']),
		prefix: z.string().optional(),
		signedPayload: z.enum(['body', 'timestamp.body']).optional(),
	})
	.nullable()

export const webhookReplayPublicSchema = z
	.object({
		timestampHeader: z.string().optional(),
		timestampFormat: z
			.enum(['unix-seconds', 'unix-millis', 'iso-8601', 'stripe-signature'])
			.optional(),
		toleranceSeconds: z.number().int().optional(),
		deliveryIdHeader: z.string().optional(),
	})
	.nullable()

export const listedWebhookSchema = z.object({
	package_id: z.string(),
	package_kody_id: z.string(),
	package_name: z.string(),
	name: z.string(),
	export_name: z.string(),
	description: z.string().nullable(),
	response_mode: z.enum(['ack', 'sync']),
	input_mode: z.enum(['request', 'params']),
	rate_limit_per_minute: z.number().int(),
	verification: webhookVerificationPublicSchema,
	replay: webhookReplayPublicSchema,
	minted: z
		.boolean()
		.describe('True when a URL secret has been minted for this webhook.'),
	handle: z
		.string()
		.nullable()
		.describe(
			'Opaque handle for webhookUrlApply. Null when not minted. Never a credential.',
		),
	url_host: z
		.string()
		.nullable()
		.describe('Public hostname of the ingress origin. Null when not minted.'),
	enabled: z
		.boolean()
		.nullable()
		.describe('Null when not minted; otherwise the mint enabled flag.'),
	created_at: z.string().nullable(),
	rotated_at: z.string().nullable(),
})

export const mintedWebhookHandleSchema = z.object({
	package_id: z.string(),
	package_kody_id: z.string(),
	name: z.string(),
	handle: z
		.string()
		.describe(
			'Opaque handle for webhookUrlApply. Does not contain the URL secret.',
		),
	url_host: z
		.string()
		.describe('Public hostname of the ingress origin (no path or secret).'),
	enabled: z.boolean(),
	created_at: z.string(),
	rotated_at: z.string(),
})

export const webhookUrlApplyResultSchema = z.object({
	ok: z.boolean(),
	url_host: z.string(),
	http_status: z.number().int(),
	remote_id: z.string().nullable(),
	error: z.string().nullable(),
})

export const webhookDeliverySchema = z.object({
	id: z.string(),
	package_id: z.string(),
	webhook_name: z.string(),
	received_at: z.string(),
	outcome: z.enum(['delivered', 'rejected', 'failed']),
	http_status: z.number().int(),
	error: z.string().nullable(),
	payload_bytes: z.number().int(),
})

export function requirePackageRef(input: {
	packageId?: string
	kodyId?: string
}) {
	if (!input.packageId && !input.kodyId) {
		throw new Error('Provide packageId or kodyId.')
	}
}

export function toListedWebhookCapability(webhook: {
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification: z.infer<typeof webhookVerificationPublicSchema>
	replay?: z.infer<typeof webhookReplayPublicSchema>
	minted: boolean
	handle: string | null
	urlHost: string | null
	enabled: boolean | null
	createdAt: string | null
	rotatedAt: string | null
}) {
	return {
		package_id: webhook.packageId,
		package_kody_id: webhook.packageKodyId,
		package_name: webhook.packageName,
		name: webhook.name,
		export_name: webhook.exportName,
		description: webhook.description,
		response_mode: webhook.responseMode,
		input_mode: webhook.inputMode,
		rate_limit_per_minute: webhook.rateLimitPerMinute,
		verification: webhook.verification,
		replay: webhook.replay ?? null,
		minted: webhook.minted,
		handle: webhook.handle,
		url_host: webhook.urlHost,
		enabled: webhook.enabled,
		created_at: webhook.createdAt,
		rotated_at: webhook.rotatedAt,
	}
}

export function toMintedWebhookCapability(minted: {
	packageId: string
	packageKodyId: string
	name: string
	handle: string
	urlHost: string
	enabled: boolean
	createdAt: string
	rotatedAt: string
}) {
	return {
		package_id: minted.packageId,
		package_kody_id: minted.packageKodyId,
		name: minted.name,
		handle: minted.handle,
		url_host: minted.urlHost,
		enabled: minted.enabled,
		created_at: minted.createdAt,
		rotated_at: minted.rotatedAt,
	}
}

export function toAppliedWebhookCapability(applied: {
	ok: boolean
	urlHost: string
	httpStatus: number
	remoteId: string | null
	error: string | null
}) {
	return {
		ok: applied.ok,
		url_host: applied.urlHost,
		http_status: applied.httpStatus,
		remote_id: applied.remoteId,
		error: applied.error,
	}
}

export function toDeliveryCapability(delivery: {
	id: string
	packageId: string
	webhookName: string
	receivedAt: string
	outcome: 'delivered' | 'rejected' | 'failed'
	httpStatus: number
	error: string | null
	payloadBytes: number
}) {
	return {
		id: delivery.id,
		package_id: delivery.packageId,
		webhook_name: delivery.webhookName,
		received_at: delivery.receivedAt,
		outcome: delivery.outcome,
		http_status: delivery.httpStatus,
		error: delivery.error,
		payload_bytes: delivery.payloadBytes,
	}
}
