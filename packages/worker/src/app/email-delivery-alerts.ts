import { joinAppUrl } from '#worker/app-base-url.ts'
import { pruneDeliveryAlertEvents } from '#worker/email/delivery-alert-events.ts'
import { dispatchEmailDeliveryBurstSubscriptionEvent } from './email-delivery-burst-package-subscriptions.ts'
import { buildEmailDeliveryBurstEvent } from './email-delivery-burst-subscription-event.ts'

export const emailDeliveryAlertWindowMinutes = 60
export const emailDeliveryAlertThreshold = 20
export const emailDeliveryAlertCooldownMinutes = 6 * 60
export const emailDeliveryAlertKvKey = 'ops-alert:email-delivery-burst:v2'

type EmailDeliveryAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunEmailDeliveryAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export type EmailDeliveryAlertResult =
	| { status: 'below_threshold'; count: number }
	| { status: 'cooldown'; count: number }
	| { status: 'notified'; count: number }
	| { status: 'skipped'; reason: 'notify_failed' }

export async function checkEmailDeliveryBurstAndNotify(input: {
	env: EmailDeliveryAlertEnv
	now?: Date
	threshold?: number
	windowMinutes?: number
	cooldownMinutes?: number
}): Promise<EmailDeliveryAlertResult> {
	const now = input.now ?? new Date()
	const threshold = input.threshold ?? emailDeliveryAlertThreshold
	const windowMinutes = input.windowMinutes ?? emailDeliveryAlertWindowMinutes
	const cooldownMinutes =
		input.cooldownMinutes ?? emailDeliveryAlertCooldownMinutes
	const windowStart = new Date(
		now.getTime() - windowMinutes * 60_000,
	).toISOString()
	const row = await input.env.APP_DB.prepare(
		`SELECT COUNT(*) AS count
		FROM email_delivery_alert_events
		WHERE provider = 'cloudflare-email'
			AND event_type IN ('complained', 'bounced')
			AND occurred_at >= ?`,
	)
		.bind(windowStart)
		.first<{ count: number }>()
	const count = Number(row?.count ?? 0)
	await pruneDeliveryAlertEvents({ db: input.env.APP_DB, now })
	if (count < threshold) return { status: 'below_threshold', count }

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const lastSentRaw = await input.env.BUNDLE_ARTIFACTS_KV.get(
			emailDeliveryAlertKvKey,
		)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : Number.NaN
		if (
			Number.isFinite(lastSentMs) &&
			now.getTime() - lastSentMs < cooldownMinutes * 60_000
		) {
			return { status: 'cooldown', count }
		}
	}

	try {
		await dispatchEmailDeliveryBurstSubscriptionEvent({
			env: input.env as Pick<
				Env,
				'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
			>,
			event: buildEmailDeliveryBurstEvent({
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
		console.warn('email-delivery-burst-alert-failed', error)
		return { status: 'skipped', reason: 'notify_failed' }
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			emailDeliveryAlertKvKey,
			String(now.getTime()),
			{ expirationTtl: (cooldownMinutes + 60) * 60 },
		)
	}
	console.warn('email-delivery-burst-alerted', {
		count,
		threshold,
	})
	return { status: 'notified', count }
}
