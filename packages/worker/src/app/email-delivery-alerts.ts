import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

/**
 * Hourly platform-wide email delivery reputation burst check. Reputation
 * outcomes (`complained`, `bounced`) are already recorded in
 * `email_delivery_events` and charted on `/admin/insights`; this lane emails
 * admins when the last hour crosses a threshold so sender-reputation trouble
 * is not only visible in charts.
 *
 * Complements the per-user outbound pause in
 * `packages/worker/src/email/outbound-abuse.ts` — that path stops one account;
 * this path pages operators when the shared domain is under platform-wide load.
 * Watched types match that outbound-abuse reputation set (`failed` /
 * `rejected` are delivery failures, not reputation signals).
 */

export const emailDeliveryAlertWindowMinutes = 60
/** Platform-wide reputation outcomes in one hour before admins are paged. */
export const emailDeliveryAlertThreshold = 20
/** Avoid re-paging on the same sustained spike every hour. */
export const emailDeliveryAlertCooldownMinutes = 6 * 60
export const emailDeliveryAlertKvKey = 'ops-alert:email-delivery-burst:v1'

/**
 * Reputation-relevant Cloudflare Email Sending outcomes (same signals that
 * drive per-user outbound pause). Scoped to `provider = 'cloudflare-email'`
 * so inbound routing rejections (`cloudflare-email-routing`) do not inflate
 * the count.
 */
const watchedEmailDeliveryEventTypes = ['complained', 'bounced'] as const

type EmailDeliveryAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_TOKEN?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunEmailDeliveryAlertCron(now: Date) {
	// Same hourly gate as auth-denial / retention / usage aggregation (minute 0).
	return now.getUTCMinutes() === 0
}

export type EmailDeliveryAlertResult =
	| { status: 'below_threshold'; count: number }
	| { status: 'cooldown'; count: number }
	| { status: 'notified'; count: number; recipients: number }
	| { status: 'skipped'; reason: 'no_system_domain' | 'no_admins' }

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
	const eventPlaceholders = watchedEmailDeliveryEventTypes
		.map(() => '?')
		.join(', ')
	const row = await input.env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_delivery_events
		 WHERE provider = 'cloudflare-email'
			 AND event_type IN (${eventPlaceholders})
			 AND created_at >= ?`,
	)
		.bind(...watchedEmailDeliveryEventTypes, windowStart)
		.first<{ count: number }>()
	const count = Number(row?.count ?? 0)
	if (count < threshold) {
		return { status: 'below_threshold', count }
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const lastSentRaw = await input.env.BUNDLE_ARTIFACTS_KV.get(
			emailDeliveryAlertKvKey,
		)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : NaN
		if (
			Number.isFinite(lastSentMs) &&
			now.getTime() - lastSentMs < cooldownMinutes * 60_000
		) {
			return { status: 'cooldown', count }
		}
	}

	const notified = await notifyAdminsOfEmailDeliveryBurst({
		env: input.env,
		count,
		threshold,
		windowMinutes,
		now,
	})
	if (notified.status !== 'notified') {
		return notified
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			emailDeliveryAlertKvKey,
			String(now.getTime()),
			{
				// Keep the cooldown marker a bit longer than the cooldown window.
				expirationTtl: (cooldownMinutes + 60) * 60,
			},
		)
	}

	return notified
}

async function notifyAdminsOfEmailDeliveryBurst(input: {
	env: EmailDeliveryAlertEnv
	count: number
	threshold: number
	windowMinutes: number
	now: Date
}): Promise<
	| { status: 'notified'; count: number; recipients: number }
	| { status: 'skipped'; reason: 'no_system_domain' | 'no_admins' }
> {
	const systemDomain = getSystemEmailDomain(input.env)
	if (!systemDomain) {
		return { status: 'skipped', reason: 'no_system_domain' }
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
		return { status: 'skipped', reason: 'no_admins' }
	}

	const baseUrl = input.env.APP_BASE_URL?.trim() || `https://${systemDomain}`
	const text = [
		`Kody recorded ${input.count} reputation-relevant email delivery outcomes (complained or bounced) in the last ${input.windowMinutes} minutes (threshold ${input.threshold}).`,
		'Per-user outbound pause already stops individual abusers; a platform-wide burst can mean the shared sending domain is under pressure.',
		`Review the Email delivery health chart at ${baseUrl}/admin/insights.`,
		`Checked at ${input.now.toISOString()}.`,
	].join('\n\n')

	try {
		const sent = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: recipients.length === 1 ? recipients[0]! : recipients,
				from: `kody@${systemDomain}`,
				subject: `Email delivery reputation burst: ${input.count} in ${input.windowMinutes}m`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
					.join('')}</body></html>`,
			},
		)
		if (!sent.ok) {
			// Do not write cooldown when Cloudflare email is unconfigured.
			throw new Error(
				sent.skipped
					? 'Cloudflare email sending is not configured.'
					: 'Failed to send email delivery reputation alert.',
			)
		}
	} catch (error) {
		console.warn('email-delivery-alert-notification-failed', error)
		throw error
	}

	console.warn('email-delivery-burst-alerted', {
		count: input.count,
		threshold: input.threshold,
		recipients: recipients.length,
	})

	return {
		status: 'notified',
		count: input.count,
		recipients: recipients.length,
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}
