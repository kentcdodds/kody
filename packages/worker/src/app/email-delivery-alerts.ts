import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { pruneDeliveryAlertEvents } from '#worker/email/delivery-alert-events.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

export const emailDeliveryAlertWindowMinutes = 60
export const emailDeliveryAlertThreshold = 20
export const emailDeliveryAlertCooldownMinutes = 6 * 60
export const emailDeliveryAlertKvKey = 'ops-alert:email-delivery-burst:v2'

type EmailDeliveryAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_TOKEN?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunEmailDeliveryAlertCron(now: Date) {
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

	const systemDomain = getSystemEmailDomain(input.env)
	if (!systemDomain) {
		return { status: 'skipped', reason: 'no_system_domain' }
	}
	const admins = await input.env.APP_DB.prepare(
		`SELECT user.email
		FROM users AS user
		INNER JOIN user_roles AS user_role ON user_role.user_id = user.id
		INNER JOIN roles AS role ON role.id = user_role.role_id
		WHERE role.name = 'admin'
		ORDER BY user.id ASC`,
	).all<{ email: string }>()
	const recipients = (admins.results ?? []).map((admin) => admin.email)
	if (recipients.length === 0) {
		return { status: 'skipped', reason: 'no_admins' }
	}
	const insightsUrl = joinAppUrl({
		env: input.env,
		path: '/admin/insights',
	})
	const text = [
		`Kody recorded ${count} bounced or complained email outcomes in the last ${windowMinutes} minutes (threshold ${threshold}).`,
		`Review Email delivery health at ${insightsUrl}.`,
		`Checked at ${now.toISOString()}.`,
	].join('\n\n')
	const sent = await sendCloudflareEmail(
		{
			accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
			apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
			apiToken: input.env.CLOUDFLARE_API_TOKEN,
		},
		{
			to: recipients.length === 1 ? recipients[0]! : recipients,
			from: `kody@${systemDomain}`,
			subject: `Email delivery reputation burst: ${count} in ${windowMinutes}m`,
			text,
			html: `<p>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n\n', '</p><p>')}</p>`,
		},
	)
	if (!sent.ok) throw new Error('Failed to send email delivery alert.')
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
		recipients: recipients.length,
	})
	return { status: 'notified', count, recipients: recipients.length }
}
