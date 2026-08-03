import { z } from 'zod'
import { type MailboxEnv } from './mailbox-client.ts'
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
	env: MailboxEnv & { APP_DB: D1Database }
	reportingEnv?: EmailReportingEnv
	body: unknown
}) {
	const providerEvent = parseCloudflareEmailDeliveryEvent(input.body)
	if (!providerEvent) {
		return {
			outcome: 'invalid' as const,
			providerEvent: null,
			event: null,
			message: null,
		}
	}
	const result = await recordProviderEmailDeliveryEvent({
		env: input.env,
		reportingEnv: input.reportingEnv,
		providerMessageId: providerEvent.payload.messageId,
		providerEventId: providerEvent.payload.eventId,
		deliveryStatus: providerEvent.payload.delivery.status,
		eventTimestamp: providerEvent.metadata.eventTimestamp,
		detail: {
			source: providerEvent.source,
			sender: providerEvent.payload.sender,
			recipient: providerEvent.payload.recipient,
			subject: providerEvent.payload.subject ?? null,
			terminal: providerEvent.payload.terminal,
			delivery: providerEvent.payload.delivery,
			bounce: providerEvent.payload.bounce ?? null,
			failure: providerEvent.payload.failure ?? null,
			rejection: providerEvent.payload.rejection ?? null,
			complaint: providerEvent.payload.complaint ?? null,
			metadata: providerEvent.metadata,
		},
	})
	return { ...result, providerEvent }
}
