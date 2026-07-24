import { z } from 'zod'

export const webhookPackageRefSchema = {
	packageId: z
		.string()
		.min(1)
		.optional()
		.describe('Saved package id. Provide packageId or kodyId.'),
	kodyId: z
		.string()
		.min(1)
		.optional()
		.describe('Saved package kody id. Provide packageId or kodyId.'),
}

export const webhookVerificationPublicSchema = z
	.object({
		type: z.enum(['hmac-sha256', 'hmac-sha1']),
		header: z.string(),
		secretName: z.string(),
		encoding: z.enum(['hex', 'base64']),
		prefix: z.string().optional(),
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
	verification: webhookVerificationPublicSchema,
	minted: z
		.boolean()
		.describe('True when a URL secret has been minted for this webhook.'),
	enabled: z
		.boolean()
		.nullable()
		.describe('Null when not minted; otherwise the mint enabled flag.'),
	created_at: z.string().nullable(),
	rotated_at: z.string().nullable(),
})

export const mintedWebhookUrlSchema = z.object({
	package_id: z.string(),
	package_kody_id: z.string(),
	name: z.string(),
	url: z
		.string()
		.describe(
			'Full ingress URL including the URL secret. Treat as a credential; shown only on mint/rotate.',
		),
	url_secret: z
		.string()
		.describe(
			'URL path secret. Shown only on mint/rotate; never retrievable later.',
		),
	enabled: z.boolean(),
	created_at: z.string(),
	rotated_at: z.string(),
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
	verification: z.infer<typeof webhookVerificationPublicSchema>
	minted: boolean
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
		verification: webhook.verification,
		minted: webhook.minted,
		enabled: webhook.enabled,
		created_at: webhook.createdAt,
		rotated_at: webhook.rotatedAt,
	}
}

export function toMintedWebhookCapability(minted: {
	packageId: string
	packageKodyId: string
	name: string
	url: string
	urlSecret: string
	enabled: boolean
	createdAt: string
	rotatedAt: string
}) {
	return {
		package_id: minted.packageId,
		package_kody_id: minted.packageKodyId,
		name: minted.name,
		url: minted.url,
		url_secret: minted.urlSecret,
		enabled: minted.enabled,
		created_at: minted.createdAt,
		rotated_at: minted.rotatedAt,
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
