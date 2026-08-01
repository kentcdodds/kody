import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

/**
 * Hourly MCP auth-denial burst check. Denials are already recorded in
 * `audit_events` and charted on `/admin/insights`; this lane emails admins when
 * the last hour crosses a threshold so a probe is not only visible in charts.
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
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_TOKEN?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunAuthDenialAlertCron(now: Date) {
	// Same hourly gate as retention / usage aggregation (minute 0).
	return now.getUTCMinutes() === 0
}

export type AuthDenialAlertResult =
	| { status: 'below_threshold'; count: number }
	| { status: 'cooldown'; count: number }
	| { status: 'notified'; count: number; recipients: number }
	| { status: 'skipped'; reason: 'no_system_domain' | 'no_admins' }

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

	const notified = await notifyAdminsOfAuthDenialBurst({
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
			authDenialAlertKvKey,
			String(now.getTime()),
			{
				// Keep the cooldown marker a bit longer than the cooldown window.
				expirationTtl: (cooldownMinutes + 60) * 60,
			},
		)
	}

	return notified
}

async function notifyAdminsOfAuthDenialBurst(input: {
	env: AuthDenialAlertEnv
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
		`Kody recorded ${input.count} MCP auth denials in the last ${input.windowMinutes} minutes (threshold ${input.threshold}).`,
		'A single denial is routine; a burst can mean permission probing or a compromised account.',
		`Review the failure charts at ${baseUrl}/admin/insights and query auth failures with admin_audit_log_query.`,
		`Checked at ${input.now.toISOString()}.`,
	].join('\n\n')

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
				subject: `MCP auth denial burst: ${input.count} in ${input.windowMinutes}m`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
					.join('')}</body></html>`,
			},
		)
	} catch (error) {
		console.warn('auth-denial-alert-notification-failed', error)
		throw error
	}

	console.warn('auth-denial-burst-alerted', {
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
