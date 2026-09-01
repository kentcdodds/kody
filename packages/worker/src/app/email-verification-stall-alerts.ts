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

export const emailVerificationStallScanCursorKvKey =
	'ops-alert:email-verification-stall:scan-cursor'

/**
 * Hourly scan for signup/verify mail that Cloudflare accepted and then
 * never confirmed. Provider accept is not delivery; SimpleLogin-style
 * silent drops never emit `user.email_verification.failed`. This lane
 * fans `user.email_verification.stalled` once per accepted send.
 *
 * The scan walks the derived stalled set in pages of
 * `emailVerificationStallScanLimit`. A KV watermark (accepted_at +
 * stable_user_id) advances each hour so later sends are not starved
 * behind the oldest unresolved rows. Idempotency still keys one ping
 * per accepted send.
 */

type StallScanCursor = {
	acceptedAt: string
	stableUserId: string
}

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
	const cursor = await readStallScanCursor(input.env.BUNDLE_ARTIFACTS_KV)
	const stalled = await listStalledVerificationPage({
		db: input.env.APP_DB,
		cutoff,
		scanLimit,
		cursor,
	})
	await writeStallScanCursor(
		input.env.BUNDLE_ARTIFACTS_KV,
		stalled.at(-1) ?? null,
	)
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

async function listStalledVerificationPage(input: {
	db: D1Database
	cutoff: string
	scanLimit: number
	cursor: StallScanCursor | null
}) {
	const afterCursor = await queryStalledVerificationRows({
		...input,
		cursor: input.cursor,
	})
	if (afterCursor.length > 0 || !input.cursor) return afterCursor
	return await queryStalledVerificationRows({
		...input,
		cursor: null,
	})
}

async function queryStalledVerificationRows(input: {
	db: D1Database
	cutoff: string
	scanLimit: number
	cursor: StallScanCursor | null
}) {
	const stallClause = emailVerificationStallSqlConditions().join('\n			AND ')
	if (!input.cursor) {
		const rows = await input.db
			.prepare(
				`SELECT username, email, stable_user_id, email_verification_delivery_at
				FROM users
				WHERE ${stallClause}
				ORDER BY email_verification_delivery_at ASC, COALESCE(stable_user_id, '') ASC
				LIMIT ?`,
			)
			.bind(input.cutoff, input.scanLimit)
			.all<StalledVerificationRow>()
		return rows.results ?? []
	}
	const rows = await input.db
		.prepare(
			`SELECT username, email, stable_user_id, email_verification_delivery_at
			FROM users
			WHERE ${stallClause}
				AND (
					email_verification_delivery_at > ?
					OR (
						email_verification_delivery_at = ?
						AND COALESCE(stable_user_id, '') > ?
					)
				)
			ORDER BY email_verification_delivery_at ASC, COALESCE(stable_user_id, '') ASC
			LIMIT ?`,
		)
		.bind(
			input.cutoff,
			input.cursor.acceptedAt,
			input.cursor.acceptedAt,
			input.cursor.stableUserId,
			input.scanLimit,
		)
		.all<StalledVerificationRow>()
	return rows.results ?? []
}

async function readStallScanCursor(kv?: KVNamespace) {
	if (!kv) return null
	const raw = await kv.get(emailVerificationStallScanCursorKvKey)
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<StallScanCursor>
		const acceptedAt = parsed.acceptedAt?.trim() ?? ''
		const stableUserId = parsed.stableUserId?.trim() ?? ''
		if (!acceptedAt) return null
		return { acceptedAt, stableUserId }
	} catch {
		return null
	}
}

async function writeStallScanCursor(
	kv: KVNamespace | undefined,
	row: StalledVerificationRow | null,
) {
	if (!kv || !row) return
	await kv.put(
		emailVerificationStallScanCursorKvKey,
		JSON.stringify({
			acceptedAt: row.email_verification_delivery_at,
			stableUserId: row.stable_user_id?.trim() ?? '',
		} satisfies StallScanCursor),
	)
}
