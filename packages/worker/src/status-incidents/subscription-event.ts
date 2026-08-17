export const statusIncidentOpenedTopic = 'status.incident.opened'
export const statusIncidentResolvedTopic = 'status.incident.resolved'

export const statusIncidentEventTopics = [
	statusIncidentOpenedTopic,
	statusIncidentResolvedTopic,
] as const

export type StatusIncidentOpenedTopic = typeof statusIncidentOpenedTopic
export type StatusIncidentResolvedTopic = typeof statusIncidentResolvedTopic
export type StatusIncidentEventTopic =
	(typeof statusIncidentEventTopics)[number]

type StatusIncidentOpenedFields = {
	component: string
	detail: string | null
	started_at: string
}

type StatusIncidentResolvedFields = StatusIncidentOpenedFields & {
	resolved_at: string
}

export type StatusIncidentOpenedEvent = {
	event: StatusIncidentOpenedTopic
	status_url: string
	incident: StatusIncidentOpenedFields
}

export type StatusIncidentResolvedEvent = {
	event: StatusIncidentResolvedTopic
	status_url: string
	incident: StatusIncidentResolvedFields
}

export type StatusIncidentEvent =
	| StatusIncidentOpenedEvent
	| StatusIncidentResolvedEvent

export function isStatusIncidentEventTopic(
	value: string,
): value is StatusIncidentEventTopic {
	return (statusIncidentEventTopics as ReadonlyArray<string>).includes(value)
}

export function buildStatusIncidentOpenedEvent(input: {
	component: string
	detail: string | null
	startedAt: string
	statusUrl: string
}): StatusIncidentOpenedEvent {
	return {
		event: statusIncidentOpenedTopic,
		status_url: input.statusUrl,
		incident: {
			component: input.component,
			detail: input.detail,
			started_at: input.startedAt,
		},
	}
}

export function buildStatusIncidentResolvedEvent(input: {
	component: string
	detail: string | null
	startedAt: string
	resolvedAt: string
	statusUrl: string
}): StatusIncidentResolvedEvent {
	return {
		event: statusIncidentResolvedTopic,
		status_url: input.statusUrl,
		incident: {
			component: input.component,
			detail: input.detail,
			started_at: input.startedAt,
			resolved_at: input.resolvedAt,
		},
	}
}

export function buildStatusIncidentIdempotencyKey(input: {
	event: StatusIncidentEvent
	packageId: string
}) {
	switch (input.event.event) {
		case statusIncidentOpenedTopic:
			return `status-incident:${input.event.event}:${input.event.incident.component}:${input.event.incident.started_at}:${input.packageId}`
		case statusIncidentResolvedTopic:
			return `status-incident:${input.event.event}:${input.event.incident.component}:${input.event.incident.started_at}:${input.event.incident.resolved_at}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(
				`Unsupported status incident event: ${String(exhaustive)}`,
			)
		}
	}
}
