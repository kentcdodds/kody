import { z } from 'zod'
import { type EmailReportingEnv } from './reporting-events.ts'
import { recordProviderEmailDeliveryEvent } from './service.ts'
import { emailDeliveryStatusValues, type EmailDeliveryStatus } from './types.ts'

const cloudflareEmailDeliveryTypeValues = [
	'cf.email.sending.message.delivered',
	'cf.email.sending.message.deferred',
	'cf.email.sending.message.bounced',
	'cf.email.sending.message.failed',
	'cf.email.sending.message.rejected',
	'cf.email.sending.message.complained',
] as const

const optionalDetailSchema = z.record(z.string(), z.unknown()).optional()

const cloudflareEmailDeliveryEventSchema = z.object({
	type: z.enum(cloudflareEmailDeliveryTypeValues),
	source: z.object({
		type: z.literal('email.sending'),
		zoneId: z.string().min(1),
		domain: z.string().min(1),
	}),
	payload: z.object({
		eventId: z.string().min(1),
		messageId: z.string().min(1),
		sender: z.string().min(1),
		recipient: z.string().min(1),
		subject: z.string().optional(),
		terminal: z.boolean(),
		delivery: z
			.object({
				status: z.enum(emailDeliveryStatusValues),
				provider: z.string().optional(),
				deliveryTimeMs: z.number().optional(),
				smtpStatusCode: z.string().optional(),
				smtpEnhancedStatusCode: z.string().optional(),
				smtpResponse: z.string().optional(),
			})
			.passthrough(),
		bounce: optionalDetailSchema,
		failure: optionalDetailSchema,
		rejection: optionalDetailSchema,
		complaint: optionalDetailSchema,
	}),
	metadata: z.object({
		accountId: z.string().min(1),
		eventSubscriptionId: z.string().min(1),
		eventSchemaVersion: z.number().int().positive(),
		eventTimestamp: z.iso.datetime(),
	}),
})

export type CloudflareEmailDeliveryEvent = z.infer<
	typeof cloudflareEmailDeliveryEventSchema
>

function statusForEventType(
	type: CloudflareEmailDeliveryEvent['type'],
): EmailDeliveryStatus {
	switch (type) {
		case 'cf.email.sending.message.delivered':
			return 'delivered'
		case 'cf.email.sending.message.deferred':
			return 'deferred'
		case 'cf.email.sending.message.bounced':
			return 'bounced'
		case 'cf.email.sending.message.failed':
			return 'failed'
		case 'cf.email.sending.message.rejected':
			return 'rejected'
		case 'cf.email.sending.message.complained':
			return 'complained'
		default: {
			const exhaustive: never = type
			throw new Error(`Unsupported email delivery event type: ${exhaustive}`)
		}
	}
}

export function parseCloudflareEmailDeliveryEvent(input: unknown) {
	const result = cloudflareEmailDeliveryEventSchema.safeParse(input)
	if (!result.success) return null
	if (
		statusForEventType(result.data.type) !== result.data.payload.delivery.status
	) {
		return null
	}
	return result.data
}

export async function processCloudflareEmailDeliveryEvent(input: {
	db: D1Database
	reportingEnv?: EmailReportingEnv
	body: unknown
}) {
	const event = parseCloudflareEmailDeliveryEvent(input.body)
	if (!event) {
		return { outcome: 'invalid' as const, event: null, message: null }
	}
	const result = await recordProviderEmailDeliveryEvent({
		db: input.db,
		reportingEnv: input.reportingEnv,
		providerMessageId: event.payload.messageId,
		providerEventId: event.payload.eventId,
		deliveryStatus: event.payload.delivery.status,
		eventTimestamp: event.metadata.eventTimestamp,
		detail: {
			source: event.source,
			sender: event.payload.sender,
			recipient: event.payload.recipient,
			subject: event.payload.subject ?? null,
			terminal: event.payload.terminal,
			delivery: event.payload.delivery,
			bounce: event.payload.bounce ?? null,
			failure: event.payload.failure ?? null,
			rejection: event.payload.rejection ?? null,
			complaint: event.payload.complaint ?? null,
			metadata: event.metadata,
		},
	})
	return { ...result, event }
}
