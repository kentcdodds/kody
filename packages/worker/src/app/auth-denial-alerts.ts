import { joinAppUrl } from '#worker/app-base-url.ts'
import { dispatchAuthDenialBurstSubscriptionEvent } from './auth-denial-package-subscriptions.ts'
import { buildAuthDenialBurstEvent } from './auth-denial-subscription-event.ts'

/**
 * Hourly MCP auth-denial burst check. Denials are already recorded in
 * `audit_events` and charted on `/admin/insights`; this lane fans
 * `auth.denial.burst` when the last hour crosses a threshold so a probe
 * is not only visible in charts.
 */

export const authDenialAlertWindowMinutes = 60
export const authDenialAlertThreshold = 50
/** Avoid re-paging on the same sustained spike every hour. */
export const authDenialAlertCooldownMinutes = 6 * 60
export const authDenialAlertKvKey = 'ops-alert:auth-denial-burst:v1'

const watchedAuthDenialActions = [
	'mcp_token_rejected',
	'mcp_capability_denied',
] as const

type AuthDenialAlertEnv = {
	APP_DB: D1Database
	AUDIT_DB: D1Database
	APP_BASE_URL?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunAuthDenialAlertCron(now: Date) {
	// Same hourly gate as retention / usage aggregation (minute 0).
	return now.getUTCMinutes() === 0
}

export type AuthDenialAlertResult =
	| { status: 'below_threshold'; count: number }
	| { status: 'cooldown'; count: number }
	| { status: 'notified'; count: number }
	| { status: 'skipped'; reason: 'notify_failed' }

export async function checkAuthDenialBurstAndNotify(input: {
	env: AuthDenialAlertEnv
	now?: Date
	threshold?: number
	windowMinutes?: number
	cooldownMinutes?: number
}): Promise<AuthDenialAlertResult> {
	const now = input.now ?? new Date()
	const threshold = input.threshold ?? authDenialAlertThreshold
	const windowMinutes = input.windowMinutes ?? authDenialAlertWindowMinutes
	const cooldownMinutes =
		input.cooldownMinutes ?? authDenialAlertCooldownMinutes

	const windowStart = new Date(
		now.getTime() - windowMinutes * 60_000,
	).toISOString()
	const actionPlaceholders = watchedAuthDenialActions.map(() => '?').join(', ')
	const row = await input.env.AUDIT_DB.prepare(
		`SELECT COUNT(*) AS count FROM audit_events
		 WHERE category = 'auth'
			 AND result = 'failure'
			 AND action IN (${actionPlaceholders})
			 AND timestamp >= ?`,
	)
		.bind(...watchedAuthDenialActions, windowStart)
		.first<{ count: number }>()
	const count = Number(row?.count ?? 0)
	if (count < threshold) {
		return { status: 'below_threshold', count }
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const lastSentRaw =
			await input.env.BUNDLE_ARTIFACTS_KV.get(authDenialAlertKvKey)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : NaN
		if (
			Number.isFinite(lastSentMs) &&
			now.getTime() - lastSentMs < cooldownMinutes * 60_000
		) {
			return { status: 'cooldown', count }
		}
	}

	try {
		await dispatchAuthDenialBurstSubscriptionEvent({
			env: input.env as Pick<
				Env,
				'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
			>,
			event: buildAuthDenialBurstEvent({
				count,
				threshold,
				windowMinutes,
				insightsUrl: joinAppUrl({
					env: input.env,
					path: '/admin/insights',
				}),
				observedAt: now.toISOString(),
			}),
		})
	} catch (error) {
		console.warn('auth-denial-alert-notification-failed', error)
		return { status: 'skipped', reason: 'notify_failed' }
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			authDenialAlertKvKey,
			String(now.getTime()),
			{
				// Keep the cooldown marker a bit longer than the cooldown window.
				expirationTtl: (cooldownMinutes + 60) * 60,
			},
		)
	}

	console.warn('auth-denial-burst-alerted', {
		count,
		threshold,
	})

	return { status: 'notified', count }
}
