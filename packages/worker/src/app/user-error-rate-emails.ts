import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildUserErrorRateEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { kodyIssueTriageListingPath } from '#universal/community-links.ts'
import { observeOnlyUsageEventTypes } from '#universal/usage-event-types.ts'

const observeOnlyMetricPlaceholders = observeOnlyUsageEventTypes
	.map(() => '?')
	.join(', ')

export const userErrorRateEmailKvKeyPrefix = 'error-rate-email-user:v1'
export const userErrorRateEmailSweepLimit = 80
export const userErrorRateEmailClaimTtlSeconds = 40 * 24 * 60 * 60
export const userErrorRateMinErrors = 5
export const userErrorRateMinPercent = 0.2
export const userErrorRateAbsoluteErrors = 10

export function userErrorRateEmailKvKey(input: {
	userId: string
	month: string
}) {
	return `${userErrorRateEmailKvKeyPrefix}:${input.userId}:${input.month}`
}

export function shouldSendUserErrorRateEmail(input: {
	errorCount: number
	eventCount: number
}) {
	if (input.errorCount >= userErrorRateAbsoluteErrors) return true
	if (input.errorCount < userErrorRateMinErrors) return false
	if (input.eventCount <= 0) return false
	return input.errorCount / input.eventCount >= userErrorRateMinPercent
}

type ErrorRateCandidate = {
	stable_user_id: string
	email: string
	event_count: number
	error_count: number
}

export type UserErrorRateEmailResult =
	| { status: 'skipped'; reason: 'no_kv' | 'no_email_config' }
	| { status: 'no_warnings' }
	| { status: 'notified'; emailedUsers: number }

export async function sendUserErrorRateEmails(input: {
	env: Env
	now?: Date
}): Promise<UserErrorRateEmailResult> {
	const now = input.now ?? new Date()
	if (!input.env.BUNDLE_ARTIFACTS_KV) {
		return { status: 'skipped', reason: 'no_kv' }
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) {
		return { status: 'skipped', reason: 'no_email_config' }
	}

	const month = utcMonthKey(now)
	const candidates = await input.env.APP_DB.prepare(
		`SELECT u.stable_user_id, u.email,
		        SUM(r.event_count) AS event_count,
		        SUM(r.error_count) AS error_count
		 FROM usage_rollups r
		 INNER JOIN users u ON u.stable_user_id = r.user_id
		 WHERE r.month = ?
		   AND r.metric NOT IN (${observeOnlyMetricPlaceholders})
		   AND u.deleting_at IS NULL
		   AND u.account_type = 'person'
		   AND u.email_verified_at IS NOT NULL
		 GROUP BY u.stable_user_id
		 HAVING SUM(r.error_count) >= ?
		 ORDER BY SUM(r.error_count) DESC
		 LIMIT ?`,
	)
		.bind(
			month,
			...observeOnlyUsageEventTypes,
			userErrorRateMinErrors,
			userErrorRateEmailSweepLimit,
		)
		.all<ErrorRateCandidate>()

	const rows = candidates.results ?? []
	let emailedUsers = 0
	for (const user of rows) {
		if (
			!shouldSendUserErrorRateEmail({
				errorCount: Number(user.error_count),
				eventCount: Number(user.event_count),
			})
		) {
			continue
		}
		const sent = await sendOneUserErrorRateEmail({
			env: input.env,
			emailConfig,
			user: {
				...user,
				event_count: Number(user.event_count),
				error_count: Number(user.error_count),
			},
			month,
		})
		if (sent) emailedUsers += 1
	}

	if (emailedUsers === 0) return { status: 'no_warnings' }
	console.info('user-error-rate-emailed', { emailedUsers, month })
	return { status: 'notified', emailedUsers }
}

async function sendOneUserErrorRateEmail(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: ErrorRateCandidate
	month: string
}): Promise<boolean> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return false
	const key = userErrorRateEmailKvKey({
		userId: input.user.stable_user_id,
		month: input.month,
	})
	if (await kv.get(key)) return false

	const activityUrl = new URL(
		'/account/activity',
		input.emailConfig.appBaseUrl,
	).toString()
	const triagePackageUrl = new URL(
		kodyIssueTriageListingPath,
		input.emailConfig.appBaseUrl,
	).toString()
	const email = buildUserErrorRateEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		activityUrl,
		triagePackageUrl,
		errorCount: input.user.error_count,
		eventCount: input.user.event_count,
	})

	let sendResult: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		sendResult = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: input.user.email,
				from: input.emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		console.warn('user-error-rate-email-send-failed', error)
		return false
	}
	if (!sendResult.ok) {
		console.warn('user-error-rate-email-send-skipped', {
			reason: sendResult.error ?? 'unconfigured',
		})
		return false
	}

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: userErrorRateEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('user-error-rate-email-claim-failed', error)
	}
	return true
}
