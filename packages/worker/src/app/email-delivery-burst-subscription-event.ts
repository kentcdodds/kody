export const emailDeliveryBurstTopic = 'email.delivery.burst'

export const emailDeliveryBurstEventTopics = [emailDeliveryBurstTopic] as const

export type EmailDeliveryBurstTopic = typeof emailDeliveryBurstTopic

export type EmailDeliveryBurstEvent = {
	event: EmailDeliveryBurstTopic
	count: number
	threshold: number
	window_minutes: number
	insights_url: string
	observed_at: string
}

export function isEmailDeliveryBurstEventTopic(
	value: string,
): value is EmailDeliveryBurstTopic {
	return (emailDeliveryBurstEventTopics as ReadonlyArray<string>).includes(
		value,
	)
}

export function buildEmailDeliveryBurstEvent(input: {
	count: number
	threshold: number
	windowMinutes: number
	insightsUrl: string
	observedAt: string
}): EmailDeliveryBurstEvent {
	return {
		event: emailDeliveryBurstTopic,
		count: input.count,
		threshold: input.threshold,
		window_minutes: input.windowMinutes,
		insights_url: input.insightsUrl,
		observed_at: input.observedAt,
	}
}

export function buildEmailDeliveryBurstIdempotencyKey(input: {
	event: EmailDeliveryBurstEvent
	packageId: string
}) {
	return `email-delivery:${input.event.event}:${input.event.observed_at}:${input.packageId}`
}
