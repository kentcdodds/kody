import { z } from 'zod'

export const webhookVerificationPublicSchema = z.object({
	type: z.enum(['hmac-sha256', 'hmac-sha1']),
	header: z.string(),
	encoding: z.enum(['hex', 'base64']),
	prefix: z.string().optional(),
})

export const webhookVerificationInputSchema = z.object({
	type: z
		.enum(['hmac-sha256', 'hmac-sha1'])
		.describe(
			'HMAC algorithm. Use hmac-sha256 for GitHub/Sentry-style providers; hmac-sha1 only when a provider requires it.',
		),
	header: z
		.string()
		.min(1)
		.describe(
			'Request header carrying the signature (for example sentry-hook-signature or x-hub-signature-256).',
		),
	secret: z
		.string()
		.min(1)
		.describe(
			'Shared HMAC secret from the provider. Stored encrypted at rest; never returned by list/get.',
		),
	encoding: z
		.enum(['hex', 'base64'])
		.describe('Encoding of the signature bytes in the header value.'),
	prefix: z
		.string()
		.optional()
		.describe(
			"Optional literal prefix before the encoded digest (GitHub uses 'sha256=').",
		),
})

export const webhookEndpointSchema = z.object({
	id: z.string(),
	name: z.string(),
	package_id: z.string(),
	export_name: z.string(),
	response_mode: z.enum(['ack', 'sync']),
	enabled: z.boolean(),
	verification: webhookVerificationPublicSchema.nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const webhookEndpointWithSecretSchema = webhookEndpointSchema.extend({
	url: z
		.string()
		.describe(
			'Full ingress URL including the URL secret. Treat as a credential; shown only on create/rotate.',
		),
	url_secret: z
		.string()
		.describe(
			'URL path secret embedded in the endpoint URL. Shown only on create/rotate; never retrievable later.',
		),
})

export const webhookDeliverySchema = z.object({
	id: z.string(),
	endpoint_id: z.string(),
	received_at: z.string(),
	outcome: z.enum(['delivered', 'rejected', 'failed']),
	http_status: z.number().int(),
	error: z.string().nullable(),
	payload_bytes: z.number().int(),
})

export function toCapabilityEndpoint(endpoint: {
	id: string
	name: string
	packageId: string
	exportName: string
	responseMode: 'ack' | 'sync'
	enabled: boolean
	verification: z.infer<typeof webhookVerificationPublicSchema> | null
	createdAt: string
	updatedAt: string
}) {
	return {
		id: endpoint.id,
		name: endpoint.name,
		package_id: endpoint.packageId,
		export_name: endpoint.exportName,
		response_mode: endpoint.responseMode,
		enabled: endpoint.enabled,
		verification: endpoint.verification,
		created_at: endpoint.createdAt,
		updated_at: endpoint.updatedAt,
	}
}

export function toCapabilityEndpointWithSecret(endpoint: {
	id: string
	name: string
	packageId: string
	exportName: string
	responseMode: 'ack' | 'sync'
	enabled: boolean
	verification: z.infer<typeof webhookVerificationPublicSchema> | null
	createdAt: string
	updatedAt: string
	url: string
	urlSecret: string
}) {
	return {
		...toCapabilityEndpoint(endpoint),
		url: endpoint.url,
		url_secret: endpoint.urlSecret,
	}
}

export function toCapabilityDelivery(delivery: {
	id: string
	endpointId: string
	receivedAt: string
	outcome: 'delivered' | 'rejected' | 'failed'
	httpStatus: number
	error: string | null
	payloadBytes: number
}) {
	return {
		id: delivery.id,
		endpoint_id: delivery.endpointId,
		received_at: delivery.receivedAt,
		outcome: delivery.outcome,
		http_status: delivery.httpStatus,
		error: delivery.error,
		payload_bytes: delivery.payloadBytes,
	}
}
