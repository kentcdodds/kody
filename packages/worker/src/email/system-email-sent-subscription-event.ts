export const systemEmailSentTopic = 'email.system-message.sent'

export const systemEmailSentEventTopics = [systemEmailSentTopic] as const

export type SystemEmailSentTopic = typeof systemEmailSentTopic

/**
 * Operator correspondence that just left `sendSystemEmail`. Outbound system
 * mail is not stored on the dedicated inbound graph (that graph refuses
 * provider-message-id rows), so this topic carries the sent copy for admin
 * archive packages. Production fan-out is admin-only.
 */
export type SystemEmailSentEvent = {
	event: SystemEmailSentTopic
	from: string
	to: Array<string>
	subject: string
	text: string | null
	html: string | null
	reply_to: string | null
	provider_message_id: string | null
	sent_at: string
}

export function isSystemEmailSentEventTopic(
	value: string,
): value is SystemEmailSentTopic {
	return (systemEmailSentEventTopics as ReadonlyArray<string>).includes(value)
}

export function buildSystemEmailSentEvent(input: {
	from: string
	to: ReadonlyArray<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	providerMessageId?: string | null
	sentAt: string
}): SystemEmailSentEvent {
	return {
		event: systemEmailSentTopic,
		from: input.from,
		to: [...input.to],
		subject: input.subject,
		text: input.text ?? null,
		html: input.html ?? null,
		reply_to: input.replyTo ?? null,
		provider_message_id: input.providerMessageId ?? null,
		sent_at: input.sentAt,
	}
}

export function buildSystemEmailSentIdempotencyKey(input: {
	event: SystemEmailSentEvent
	packageId: string
}) {
	const sendId = input.event.provider_message_id ?? input.event.sent_at
	return `system-email-sent:${input.event.event}:${sendId}:${input.packageId}`
}
