import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'
import {
	countsOf,
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
				| { status: 'notified'; eventId: string; recipients: number }
				| { status: 'cooldown'; eventId: string }
				| {
						status: 'skipped'
						reason: 'no_system_domain' | 'no_admins'
				  }
	  }

/**
 * Recompute the anonymous fleet snapshot, then page admin packages and
 * admin email when the combined package-runtime error rate is rising.
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

	const alert = await notifyFleetPackageErrorRateElevation({
		env: input.env,
		event,
		now,
	})
	if (alert.status === 'notified') {
		const snapshot: FleetPackageErrorRateSnapshot = {
			...refreshed.snapshot,
			lastAlertAt: now.toISOString(),
			lastAlertEventId: event.event_id,
		}
		await writeFleetPackageErrorRateSnapshot(kv, snapshot)
		await kv.put(fleetPackageErrorRateAlertKvKey, String(now.getTime()), {
			expirationTtl: (cooldownMinutes + 60) * 60,
		})
	}
	return { status: 'refreshed', elevated: true, alert }
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

async function notifyFleetPackageErrorRateElevation(input: {
	env: FleetPackageErrorRateEnv
	event: FleetPackageErrorRateElevatedEvent
	now: Date
}): Promise<
	| { status: 'notified'; eventId: string; recipients: number }
	| { status: 'skipped'; reason: 'no_system_domain' | 'no_admins' }
> {
	if (!input.env.APP_DB) {
		return { status: 'skipped', reason: 'no_admins' }
	}

	try {
		await dispatchFleetPackageErrorRateSubscriptionEvent({
			env: input.env as Pick<
				Env,
				'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
			>,
			event: input.event,
		})
	} catch (error) {
		console.warn('fleet-package-error-rate-subscription-dispatch-failed', error)
	}

	const systemDomain = getSystemEmailDomain(input.env)
	if (!systemDomain) {
		return {
			status: 'notified',
			eventId: input.event.event_id,
			recipients: 0,
		}
	}

	const admins = await input.env.APP_DB.prepare(
		`SELECT u.email FROM users u
		 INNER JOIN user_roles ur ON ur.user_id = u.id
		 INNER JOIN roles r ON r.id = ur.role_id
		 WHERE r.name = 'admin'
		 ORDER BY u.id ASC`,
	).all<{ email: string }>()
	const recipients = (admins.results ?? []).map((row) => row.email)
	if (recipients.length === 0) {
		return {
			status: 'notified',
			eventId: input.event.event_id,
			recipients: 0,
		}
	}

	const text = formatFleetPackageErrorRateAlertText(input.event)
	try {
		await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: recipients.length === 1 ? recipients[0]! : recipients,
				from: `kody@${systemDomain}`,
				subject: `Fleet package error rate elevated (${input.event.trigger.window})`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
					.join('')}</body></html>`,
			},
		)
	} catch (error) {
		console.warn('fleet-package-error-rate-email-failed', error)
		throw error
	}

	console.warn('fleet-package-error-rate-alerted', {
		eventId: input.event.event_id,
		window: input.event.trigger.window,
		reason: input.event.trigger.reason,
		recipients: recipients.length,
		checkedAt: input.now.toISOString(),
	})

	return {
		status: 'notified',
		eventId: input.event.event_id,
		recipients: recipients.length,
	}
}

export function formatFleetPackageErrorRateAlertText(
	event: FleetPackageErrorRateElevatedEvent,
) {
	const recent = formatCounts(event.trigger.recent.combined)
	const previous = formatCounts(event.trigger.previous.combined)
	const metricLines = event.trigger.recent.by_metric
		.map((row, index) => {
			const prior = event.trigger.previous.by_metric[index]
			return `• ${row.metric}: ${formatCounts(row)} (was ${formatCounts(prior ?? countsOf(0, 0))})`
		})
		.join('\n')
	return [
		`Kody detected a rising anonymous fleet error rate for user-package runtime metrics (${event.trigger.window} window, ${event.trigger.reason}).`,
		`Recent ${event.trigger.recent.start} → ${event.trigger.recent.end}: ${recent}. Previous: ${previous}.`,
		metricLines,
		`Review the content-free series at ${event.insights_url}. Status: ${event.status_url}.`,
		`Environment ${event.environment}. Observed at ${event.observed_at}. Event ${event.event_id}.`,
	].join('\n\n')
}

function formatCounts(counts: { events: number; errors: number; rate: number | null }) {
	const percent =
		counts.rate == null ? 'n/a' : `${(counts.rate * 100).toFixed(1)}%`
	return `${counts.errors}/${counts.events} (${percent})`
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}
