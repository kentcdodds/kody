import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import {
	adminFleetEntitlementSweepUserLimit,
	detectFleetUsagePressure,
	fleetRuntimeDurationAlertThresholdMs,
	type FleetEntitlementPressureIssue,
} from '#worker/admin/fleet-usage-insights.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

/**
 * Hourly fleet usage / entitlement pressure check. The admin insights page
 * surfaces the same bounded sweep; this lane emails admins when pressure
 * crosses thresholds so operators do not have to poll the dashboard.
 */

export const usageEntitlementAlertCooldownMinutes = 6 * 60
export const usageEntitlementAlertKvKey =
	'ops-alert:usage-entitlement-pressure:v1'

type UsageEntitlementAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_TOKEN?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunUsageEntitlementAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export type UsageEntitlementAlertResult =
	| { status: 'no_pressure' }
	| { status: 'cooldown'; issueCount: number }
	| { status: 'notified'; issueCount: number; recipients: number }
	| { status: 'skipped'; reason: 'no_system_domain' | 'no_admins' }

export async function checkUsageEntitlementPressureAndNotify(input: {
	env: UsageEntitlementAlertEnv
	now?: Date
	cooldownMinutes?: number
	runtimeDurationThresholdMs?: number
}): Promise<UsageEntitlementAlertResult> {
	const now = input.now ?? new Date()
	const cooldownMinutes =
		input.cooldownMinutes ?? usageEntitlementAlertCooldownMinutes
	const issues = await detectFleetUsagePressure({
		db: input.env.APP_DB,
		env: input.env as Env,
		now,
		runtimeDurationThresholdMs:
			input.runtimeDurationThresholdMs ?? fleetRuntimeDurationAlertThresholdMs,
	})
	if (issues.length === 0) {
		return { status: 'no_pressure' }
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const lastSentRaw = await input.env.BUNDLE_ARTIFACTS_KV.get(
			usageEntitlementAlertKvKey,
		)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : Number.NaN
		if (
			Number.isFinite(lastSentMs) &&
			now.getTime() - lastSentMs < cooldownMinutes * 60_000
		) {
			return { status: 'cooldown', issueCount: issues.length }
		}
	}

	const notified = await notifyAdminsOfUsageEntitlementPressure({
		env: input.env,
		issues,
		now,
	})
	if (notified.status !== 'notified') {
		return notified
	}

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			usageEntitlementAlertKvKey,
			String(now.getTime()),
			{
				expirationTtl: (cooldownMinutes + 60) * 60,
			},
		)
	}

	return notified
}

async function notifyAdminsOfUsageEntitlementPressure(input: {
	env: UsageEntitlementAlertEnv
	issues: Array<FleetEntitlementPressureIssue>
	now: Date
}): Promise<
	| { status: 'notified'; issueCount: number; recipients: number }
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
	const runtimeHours = Math.round(
		fleetRuntimeDurationAlertThresholdMs / (60 * 60 * 1000),
	)
	const lines = input.issues.map((issue) =>
		formatIssueLine(issue, runtimeHours),
	)
	const text = [
		`Kody detected ${input.issues.length} fleet usage pressure signal(s) while sweeping the top ${adminFleetEntitlementSweepUserLimit} active accounts this UTC month.`,
		lines.join('\n'),
		`Review entitlement pressure and top consumers at ${baseUrl}/admin/insights, or drill into a user at ${baseUrl}/admin/users.`,
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
				subject: `Fleet usage pressure: ${input.issues.length} signal(s)`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
					.join('')}</body></html>`,
			},
		)
	} catch (error) {
		console.warn('usage-entitlement-alert-notification-failed', error)
		throw error
	}

	console.warn('usage-entitlement-pressure-alerted', {
		issueCount: input.issues.length,
		recipients: recipients.length,
	})

	return {
		status: 'notified',
		issueCount: input.issues.length,
		recipients: recipients.length,
	}
}

function formatIssueLine(
	issue: FleetEntitlementPressureIssue,
	runtimeHours: number,
) {
	if (issue.kind === 'entitlement') {
		const percent = Math.round(issue.percentOfLimit * 100)
		return `• ${issue.username} (${issue.stableUserId}): ${issue.label} at ${percent}% of plan limit`
	}
	const hours = (issue.totalDurationMs / (60 * 60 * 1000)).toFixed(1)
	return `• ${issue.username} (${issue.stableUserId}): ${hours}h combined runtime this month (threshold ${runtimeHours}h)`
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}
