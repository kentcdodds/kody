import { shouldRunEmailVerificationStallAlertCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import {
	emailVerificationStallAfterMinutes,
	emailVerificationStallCutoffIso,
	emailVerificationStallScanLimit,
	emailVerificationStallSqlConditions,
} from '#worker/identity/email-verification-stall.ts'
import { dispatchUserEmailVerificationStalledSubscriptionEvent } from '#worker/identity/email-verification-stalled-package-subscriptions.ts'
import { buildUserEmailVerificationStalledEvent } from '#worker/identity/email-verification-stalled-subscription-event.ts'

export { shouldRunEmailVerificationStallAlertCron }
export { emailVerificationStallAfterMinutes, emailVerificationStallScanLimit }

/**
 * Hourly scan for signup/verify mail that Cloudflare accepted and then
 * never confirmed. Provider accept is not delivery; SimpleLogin-style
 * silent drops never emit `user.email_verification.failed`. This lane
 * fans `user.email_verification.stalled` once per accepted send.
 */

type EmailVerificationStallAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

type StalledVerificationRow = {
	username: string
	email: string
	stable_user_id: string | null
	email_verification_delivery_at: string
}

export type EmailVerificationStallAlertResult = {
	scanned: number
	notified: number
	failed: number
}

export async function checkEmailVerificationStallsAndNotify(input: {
	env: EmailVerificationStallAlertEnv
	now?: Date
	stallAfterMinutes?: number
	scanLimit?: number
}): Promise<EmailVerificationStallAlertResult> {
	const now = input.now ?? new Date()
	const stallAfterMinutes =
		input.stallAfterMinutes ?? emailVerificationStallAfterMinutes
	const scanLimit = input.scanLimit ?? emailVerificationStallScanLimit
	const cutoff = emailVerificationStallCutoffIso(now, stallAfterMinutes)
	const rows = await input.env.APP_DB.prepare(
		`SELECT username, email, stable_user_id, email_verification_delivery_at
		FROM users
		WHERE ${emailVerificationStallSqlConditions().join('\n			AND ')}
		ORDER BY email_verification_delivery_at ASC
		LIMIT ?`,
	)
		.bind(cutoff, scanLimit)
		.all<StalledVerificationRow>()
	const stalled = rows.results ?? []
	let notified = 0
	let failed = 0
	const observedAt = now.toISOString()
	for (const row of stalled) {
		const stableUserId = row.stable_user_id?.trim() ?? ''
		const adminUsersPath = stableUserId
			? `/admin/users/${stableUserId}`
			: '/admin/users'
		try {
			await dispatchUserEmailVerificationStalledSubscriptionEvent({
				env: input.env as Pick<
					Env,
					'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
				>,
				event: buildUserEmailVerificationStalledEvent({
					user: {
						id: stableUserId || row.username,
						username: row.username,
						email: row.email,
					},
					acceptedAt: row.email_verification_delivery_at,
					stallAfterMinutes,
					adminUserUrl: joinAppUrl({
						env: input.env,
						path: adminUsersPath,
					}),
					occurredAt: observedAt,
				}),
			})
			notified += 1
		} catch (error) {
			failed += 1
			console.warn('email-verification-stall-alert-failed', {
				username: row.username,
				error,
			})
		}
	}
	return { scanned: stalled.length, notified, failed }
}
