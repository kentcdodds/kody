import { expect, test } from 'vitest'
import {
	buildFleetEntitlementCrossingIdempotencyKey,
	buildFleetEntitlementResourceCrossedEvent,
	buildFleetRuntimeDurationCrossedEvent,
	fleetEntitlementCrossedTopic,
	isFleetEntitlementCrossingEventTopic,
} from './fleet-entitlement-crossing-subscription-event.ts'

test('fleet entitlement crossing builders keep a metadata-only operator snapshot', () => {
	const entitlement = buildFleetEntitlementResourceCrossedEvent({
		user: { id: 'user-1', username: 'maciek' },
		resource: 'saved_packages',
		label: 'saved packages',
		threshold: 'reached',
		current: 10,
		limit: 10,
		percentOfLimit: 1,
		insightsUrl: 'https://kody.codes/admin/insights',
		usersUrl: 'https://kody.codes/admin/users',
		observedAt: '2026-08-24T16:00:18.000Z',
	})
	const runtime = buildFleetRuntimeDurationCrossedEvent({
		user: entitlement.user,
		totalDurationMs: 90_000_000,
		thresholdMs: 86_400_000,
		insightsUrl: entitlement.insights_url,
		usersUrl: entitlement.users_url,
		observedAt: entitlement.observed_at,
	})

	expect(entitlement).toEqual({
		event: fleetEntitlementCrossedTopic,
		kind: 'entitlement',
		user: { id: 'user-1', username: 'maciek' },
		resource: 'saved_packages',
		label: 'saved packages',
		threshold: 'reached',
		current: 10,
		limit: 10,
		percent_of_limit: 1,
		insights_url: 'https://kody.codes/admin/insights',
		users_url: 'https://kody.codes/admin/users',
		observed_at: '2026-08-24T16:00:18.000Z',
	})
	expect(runtime).toEqual({
		event: fleetEntitlementCrossedTopic,
		kind: 'runtime_duration',
		user: entitlement.user,
		total_duration_ms: 90_000_000,
		threshold_ms: 86_400_000,
		insights_url: entitlement.insights_url,
		users_url: entitlement.users_url,
		observed_at: entitlement.observed_at,
	})
	expect(isFleetEntitlementCrossingEventTopic('user.created')).toBe(false)
	expect(
		buildFleetEntitlementCrossingIdempotencyKey({
			event: entitlement,
			packageId: 'package-1',
		}),
	).toBe(
		'fleet-entitlement-crossing:fleet.entitlement.crossed:user-1:entitlement:reached:saved_packages:package-1',
	)
	expect(
		buildFleetEntitlementCrossingIdempotencyKey({
			event: runtime,
			packageId: 'package-1',
		}),
	).toBe(
		'fleet-entitlement-crossing:fleet.entitlement.crossed:user-1:runtime_duration:2026-08:package-1',
	)

	const daily = buildFleetEntitlementResourceCrossedEvent({
		user: entitlement.user,
		resource: 'execute_calls_per_day',
		label: 'execute calls per day',
		threshold: 'reached',
		current: 250,
		limit: 250,
		percentOfLimit: 1,
		insightsUrl: entitlement.insights_url,
		usersUrl: entitlement.users_url,
		observedAt: entitlement.observed_at,
	})
	expect(
		buildFleetEntitlementCrossingIdempotencyKey({
			event: daily,
			packageId: 'package-1',
		}),
	).toBe(
		'fleet-entitlement-crossing:fleet.entitlement.crossed:user-1:entitlement:reached:execute_calls_per_day:2026-08-24:package-1',
	)
})
