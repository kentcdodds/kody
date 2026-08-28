import { joinAppUrl } from '#worker/app-base-url.ts'
import {
	fleetPackageErrorRateAlertCooldownMinutes as defaultCooldownMinutes,
	refreshFleetPackageErrorRateSnapshot,
	writeFleetPackageErrorRateSnapshot,
	type FleetPackageErrorRateElevation,
	type FleetPackageErrorRateEnv,
	type FleetPackageErrorRateSnapshot,
} from '#worker/usage/fleet-package-error-rate.ts'
import {
	buildFleetPackageErrorRateElevatedEvent,
	fleetPackageErrorRatePublicStatusUrl,
	type FleetPackageErrorRateElevatedEvent,
} from '#worker/usage/fleet-package-error-rate-subscription-event.ts'
import { dispatchFleetPackageErrorRateSubscriptionEvent } from '#worker/usage/fleet-package-error-rate-subscriptions.ts'

export const fleetPackageErrorRateAlertKvKey =
	'ops-alert:fleet-package-error-rate:v1'

export { defaultCooldownMinutes as fleetPackageErrorRateAlertCooldownMinutes }

export type FleetPackageErrorRateRefreshResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'no_kv'
	  }
	| {
			status: 'refreshed'
			elevated: false
	  }
	| {
			status: 'refreshed'
			elevated: true
			alert:
				| { status: 'notified'; eventId: string }
				| { status: 'cooldown'; eventId: string }
				| { status: 'skipped'; reason: 'notify_failed' }
	  }

/**
 * Recompute the anonymous fleet snapshot, then fan
 * `fleet.package_error_rate.elevated` to admin-owned packages when the
 * combined package-runtime error rate is rising.
 */
export async function refreshFleetPackageErrorRateAndMaybeAlert(input: {
	env: FleetPackageErrorRateEnv
	now?: Date
	cooldownMinutes?: number
}): Promise<FleetPackageErrorRateRefreshResult> {
	const now = input.now ?? new Date()
	const refreshed = await refreshFleetPackageErrorRateSnapshot({
		env: input.env,
		now,
	})
	if (refreshed.status !== 'refreshed') return refreshed
	if (!refreshed.elevation) {
		return { status: 'refreshed', elevated: false }
	}

	const event = buildElevatedEvent({
		env: input.env,
		snapshot: refreshed.snapshot,
		elevation: refreshed.elevation,
		observedAt: now,
	})
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }

	const cooldownMinutes = input.cooldownMinutes ?? defaultCooldownMinutes
	if (await isAlertOnCooldown({ kv, now, cooldownMinutes })) {
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'cooldown', eventId: event.event_id },
		}
	}

	try {
		await dispatchFleetPackageErrorRateSubscriptionEvent({
			env: input.env as Pick<
				Env,
				'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
			>,
			event,
		})
		const snapshot: FleetPackageErrorRateSnapshot = {
			...refreshed.snapshot,
			lastAlertAt: now.toISOString(),
			lastAlertEventId: event.event_id,
		}
		await writeFleetPackageErrorRateSnapshot(kv, snapshot)
		await kv.put(fleetPackageErrorRateAlertKvKey, String(now.getTime()), {
			expirationTtl: (cooldownMinutes + 60) * 60,
		})
		console.warn('fleet-package-error-rate-alerted', {
			eventId: event.event_id,
			window: event.trigger.window,
			reason: event.trigger.reason,
			checkedAt: now.toISOString(),
		})
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'notified', eventId: event.event_id },
		}
	} catch (error) {
		console.warn('fleet-package-error-rate-alert-failed', error)
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'skipped', reason: 'notify_failed' },
		}
	}
}

function buildElevatedEvent(input: {
	env: FleetPackageErrorRateEnv
	snapshot: FleetPackageErrorRateSnapshot
	elevation: FleetPackageErrorRateElevation
	observedAt: Date
}): FleetPackageErrorRateElevatedEvent {
	return buildFleetPackageErrorRateElevatedEvent({
		eventId: `${input.elevation.kind}:${input.elevation.comparison.recent.end}`,
		statusUrl: fleetPackageErrorRatePublicStatusUrl,
		insightsUrl: joinAppUrl({
			env: input.env,
			path: '/admin/insights',
		}),
		environment: input.snapshot.environment,
		observedAt: input.observedAt.toISOString(),
		window: input.elevation.kind,
		reason: input.elevation.reason,
		recent: input.elevation.comparison.recent,
		previous: input.elevation.comparison.previous,
	})
}

async function isAlertOnCooldown(input: {
	kv: KVNamespace
	now: Date
	cooldownMinutes: number
}) {
	try {
		const lastSentRaw = await input.kv.get(fleetPackageErrorRateAlertKvKey)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : Number.NaN
		return (
			Number.isFinite(lastSentMs) &&
			input.now.getTime() - lastSentMs < input.cooldownMinutes * 60_000
		)
	} catch (error) {
		console.debug('fleet-package-error-rate-cooldown-read-failed', error)
		return false
	}
}
