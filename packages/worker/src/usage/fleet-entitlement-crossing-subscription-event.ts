import type { AdminUsageEntitlementResource } from '#universal/loader-data.ts'

export const fleetEntitlementCrossedTopic = 'fleet.entitlement.crossed'

export const fleetEntitlementCrossingEventTopics = [
	fleetEntitlementCrossedTopic,
] as const

export type FleetEntitlementCrossedTopic = typeof fleetEntitlementCrossedTopic

export const fleetEntitlementCrossingThresholds = [
	'approaching',
	'reached',
] as const

export type FleetEntitlementCrossingThreshold =
	(typeof fleetEntitlementCrossingThresholds)[number]

export type FleetEntitlementCrossingKind = 'entitlement' | 'runtime_duration'

export type FleetEntitlementCrossingUser = {
	id: string
	username: string
}

export type FleetEntitlementResourceCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'entitlement'
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	label: string
	threshold: FleetEntitlementCrossingThreshold
	current: number
	limit: number
	percent_of_limit: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetRuntimeDurationCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'runtime_duration'
	user: FleetEntitlementCrossingUser
	total_duration_ms: number
	threshold_ms: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetEntitlementCrossedEvent =
	| FleetEntitlementResourceCrossedEvent
	| FleetRuntimeDurationCrossedEvent

export function isFleetEntitlementCrossingEventTopic(
	value: string,
): value is FleetEntitlementCrossedTopic {
	return (
		fleetEntitlementCrossingEventTopics as ReadonlyArray<string>
	).includes(value)
}

export function buildFleetEntitlementResourceCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	label: string
	threshold: FleetEntitlementCrossingThreshold
	current: number
	limit: number
	percentOfLimit: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetEntitlementResourceCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'entitlement',
		user: input.user,
		resource: input.resource,
		label: input.label,
		threshold: input.threshold,
		current: input.current,
		limit: input.limit,
		percent_of_limit: input.percentOfLimit,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetRuntimeDurationCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	totalDurationMs: number
	thresholdMs: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetRuntimeDurationCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'runtime_duration',
		user: input.user,
		total_duration_ms: input.totalDurationMs,
		threshold_ms: input.thresholdMs,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetEntitlementCrossingIdempotencyKey(input: {
	event: FleetEntitlementCrossedEvent
	packageId: string
}) {
	switch (input.event.kind) {
		case 'entitlement':
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.threshold}:${input.event.resource}:${input.packageId}`
		case 'runtime_duration':
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.observed_at.slice(0, 7)}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(
				`Unsupported fleet entitlement crossing: ${String(exhaustive)}`,
			)
		}
	}
}
