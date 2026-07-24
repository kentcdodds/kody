/**
 * Automatic outbound-email abuse pause.
 *
 * All user mail sends from one shared platform domain through one
 * Cloudflare Email Sending account, so a single account generating spam
 * complaints or sustained bounces burns sender reputation for every user.
 * This monitor reacts to provider delivery events: any spam complaint, or
 * repeated hard bounces within a UTC day, sets
 * `users.email_outbound_paused_at`, which blocks further outbound sends
 * (see `sendOutboundEmail`) until an admin reviews and clears it from the
 * admin users page.
 */

import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import { type EmailDeliveryStatus } from './types.ts'

/**
 * Bounced sends tolerated per user per UTC day before outbound email is
 * paused. Complaints pause immediately: one recipient marking mail as spam
 * is already a reputation signal the shared domain cannot absorb quietly.
 */
export const outboundEmailBouncePauseThresholdPerDay = 5

export const emailOutboundPausedMessage =
	'Outbound email is paused for this account after spam complaints or repeated bounces. Contact the operator of this Kody deployment to have it reviewed and re-enabled.'

type OutboundAbuseEnv = Pick<
	Env,
	| 'APP_DB'
	| 'APP_BASE_URL'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
>

/**
 * Evaluate one provider delivery event against the abuse thresholds and
 * pause the sending account when they are exceeded. Idempotent: the pause
 * write only transitions a NULL `email_outbound_paused_at`, so replayed
 * queue messages and duplicate provider events can never re-pause or
 * re-notify. Returns whether this call performed the pause transition.
 */
export async function applyOutboundEmailAbusePause(input: {
	env: OutboundAbuseEnv
	/** Stable MCP userId of the account that sent the message. */
	userId: string
	deliveryStatus: EmailDeliveryStatus
	/**
	 * Whether this delivery event was persisted by the current processing
	 * run (queue outcome `recorded`). Replayed and conflicting-duplicate
	 * signals are deduped by provider_event_id at insert time, so the same
	 * provider event can only ever count once: non-recorded signals only
	 * pause when a matching persisted event backs them.
	 */
	eventRecorded: boolean
	now?: Date
}): Promise<{ paused: boolean }> {
	const now = input.now ?? new Date()
	switch (input.deliveryStatus) {
		case 'complained': {
			// A freshly recorded complaint always pauses. A replayed or
			// conflicting-duplicate complaint signal only pauses when a
			// real persisted complaint event backs it (crash recovery
			// between recording and pausing), never on its own.
			if (!input.eventRecorded) {
				const complaintsToday = await countProviderDeliveryEventsToday({
					db: input.env.APP_DB,
					userId: input.userId,
					eventType: 'complained',
					now,
				})
				if (complaintsToday < 1) return { paused: false }
			}
			break
		}
		case 'bounced': {
			const bouncesToday = await countProviderDeliveryEventsToday({
				db: input.env.APP_DB,
				userId: input.userId,
				eventType: 'bounced',
				now,
			})
			if (bouncesToday < outboundEmailBouncePauseThresholdPerDay) {
				return { paused: false }
			}
			break
		}
		case 'delivered':
		case 'deferred':
		case 'failed':
		case 'rejected':
			return { paused: false }
		default: {
			const exhaustive: never = input.deliveryStatus
			throw new Error(`Unsupported delivery status: ${String(exhaustive)}`)
		}
	}

	const result = await input.env.APP_DB.prepare(
		`UPDATE users
		 SET email_outbound_paused_at = ?, updated_at = ?
		 WHERE stable_user_id = ? AND email_outbound_paused_at IS NULL`,
	)
		.bind(now.toISOString(), now.toISOString(), input.userId)
		.run()
	const paused = Number(result.meta.changes ?? 0) > 0
	if (paused) {
		console.warn('email-outbound-paused', {
			deliveryStatus: input.deliveryStatus,
		})
		await notifyAdminsOfOutboundEmailPause({
			env: input.env,
			userId: input.userId,
			deliveryStatus: input.deliveryStatus,
		})
	}
	return { paused }
}

async function countProviderDeliveryEventsToday(input: {
	db: D1Database
	userId: string
	eventType: EmailDeliveryStatus
	now: Date
}) {
	const dayStart = `${utcDayKey(input.now)}T00:00:00`
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count FROM email_delivery_events
			 WHERE user_id = ?
				AND event_type = ?
				AND provider = 'cloudflare-email'
				AND created_at >= ?`,
		)
		.bind(input.userId, input.eventType, dayStart)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Best-effort operator notification through the transactional system
 * sender (`kody@<apex>`), addressed to every admin account email. A send
 * failure must never fail delivery-event processing — the pause itself is
 * already committed and the admin users page shows the paused state.
 */
async function notifyAdminsOfOutboundEmailPause(input: {
	env: OutboundAbuseEnv
	userId: string
	deliveryStatus: EmailDeliveryStatus
}) {
	try {
		const systemDomain = getSystemEmailDomain(input.env)
		if (!systemDomain) return
		// The admin roster is operator-controlled and small; no LIMIT so
		// every admin is notified.
		const admins = await input.env.APP_DB.prepare(
			`SELECT u.email, u.username FROM users u
			 INNER JOIN user_roles ur ON ur.user_id = u.id
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE r.name = 'admin'
			 ORDER BY u.id ASC`,
		).all<{ email: string; username: string }>()
		const recipients = (admins.results ?? []).map((row) => row.email)
		if (recipients.length === 0) return
		const pausedUser = await input.env.APP_DB.prepare(
			`SELECT username FROM users WHERE stable_user_id = ?`,
		)
			.bind(input.userId)
			.first<{ username: string }>()
		const username = pausedUser?.username ?? 'unknown'
		const reason =
			input.deliveryStatus === 'complained'
				? 'a spam complaint'
				: `${outboundEmailBouncePauseThresholdPerDay}+ bounced sends today`
		const text = [
			`Outbound email was automatically paused for user "${username}" after ${reason}.`,
			'The account can still receive mail and use every other capability; only outbound sending is blocked.',
			`Review the delivery history and clear the pause from ${input.env.APP_BASE_URL?.trim() || `https://${systemDomain}`}/admin/users if this was a false positive.`,
		].join('\n\n')
		await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: recipients.length === 1 ? recipients[0]! : recipients,
				from: `kody@${systemDomain}`,
				subject: `Outbound email paused for ${username}`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${paragraph}</p>`)
					.join('')}</body></html>`,
			},
		)
	} catch (error) {
		console.warn('email-outbound-pause-notification-failed', error)
	}
}
