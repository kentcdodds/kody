export const authDenialBurstTopic = 'auth.denial.burst'

export const authDenialBurstEventTopics = [authDenialBurstTopic] as const

export type AuthDenialBurstTopic = typeof authDenialBurstTopic

export type AuthDenialBurstEvent = {
	event: AuthDenialBurstTopic
	count: number
	threshold: number
	window_minutes: number
	insights_url: string
	observed_at: string
}

export function isAuthDenialBurstEventTopic(
	value: string,
): value is AuthDenialBurstTopic {
	return (authDenialBurstEventTopics as ReadonlyArray<string>).includes(value)
}

export function buildAuthDenialBurstEvent(input: {
	count: number
	threshold: number
	windowMinutes: number
	insightsUrl: string
	observedAt: string
}): AuthDenialBurstEvent {
	return {
		event: authDenialBurstTopic,
		count: input.count,
		threshold: input.threshold,
		window_minutes: input.windowMinutes,
		insights_url: input.insightsUrl,
		observed_at: input.observedAt,
	}
}

export function buildAuthDenialBurstIdempotencyKey(input: {
	event: AuthDenialBurstEvent
	packageId: string
}) {
	return `auth-denial:${input.event.event}:${input.event.observed_at}:${input.packageId}`
}
