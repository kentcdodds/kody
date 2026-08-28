import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { dispatchUserEmailVerificationFailedSubscriptionEvent } from '#worker/identity/email-verification-failed-package-subscriptions.ts'
import {
	buildUserEmailVerificationFailedEvent,
	isUserEmailVerificationFailedStatus,
} from '#worker/identity/email-verification-failed-subscription-event.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import { type RecordedTransactionalDelivery } from './verification-delivery.ts'

type VerificationNotifyEnv = Pick<
	Env,
	| 'APP_DB'
	| 'APP_BASE_URL'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
>

/**
 * Best-effort operator notification when signup/verify mail hits a terminal
 * delivery failure. Fans `user.email_verification.failed` to admin-owned
 * packages and emails every admin account. A send or dispatch failure must
 * never fail delivery-event processing — the user row already carries the
 * bounce.
 */
export async function notifyAdminsOfVerificationDeliveryFailure(input: {
	env: VerificationNotifyEnv
	event: RecordedTransactionalDelivery
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	try {
		const user = await input.env.APP_DB.prepare(
			`SELECT username, email, stable_user_id FROM users WHERE id = ?`,
		)
			.bind(input.event.userId)
			.first<{
				username: string
				email: string
				stable_user_id: string
			}>()
		const username = user?.username ?? 'unknown'
		const email = user?.email ?? input.event.recipient
		const adminUsersPath = user?.stable_user_id
			? `/admin/users/${user.stable_user_id}`
			: '/admin/users'
		const adminUserUrl = joinAppUrl({
			env: input.env,
			path: adminUsersPath,
		})
		if (isUserEmailVerificationFailedStatus(input.event.status)) {
			await dispatchUserEmailVerificationFailedSubscriptionEvent({
				env: input.env,
				event: buildUserEmailVerificationFailedEvent({
					user: {
						id: user?.stable_user_id ?? String(input.event.userId),
						username,
						email,
					},
					status: input.event.status,
					class: input.event.class,
					adminUserUrl,
					occurredAt: new Date().toISOString(),
				}),
				waitUntil: input.waitUntil,
			}).catch((error) => {
				console.warn(
					'email-verification-failed-subscription-dispatch-failed',
					error,
				)
			})
		}

		const systemDomain = getSystemEmailDomain(input.env)
		if (!systemDomain) return
		const admins = await input.env.APP_DB.prepare(
			`SELECT u.email, u.username FROM users u
			 INNER JOIN user_roles ur ON ur.user_id = u.id
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE r.name = 'admin'
			 ORDER BY u.id ASC`,
		).all<{ email: string; username: string }>()
		const recipients = (admins.results ?? []).map((row) => row.email)
		if (recipients.length === 0) return
		const recipient = redactEmailRecipient(email)
		const reason =
			input.event.class === 'sender_block'
				? `${input.event.status} (sender domain/IP block)`
				: input.event.status
		const text = [
			`Verification email ${reason} for user "${username}" (${recipient}).`,
			'The account is still unverified. Do not resend through kody.codes if this is a sender-domain block — mark the email verified after ownership is proven, or mint a verify link and send it over another path.',
			`Review the account at ${adminUserUrl}.`,
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
				subject: `Verification email ${input.event.status} for ${username}`,
				text,
				html: `<!doctype html><html lang="en"><body>${text
					.split('\n\n')
					.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
					.join('')}</body></html>`,
			},
		)
	} catch (error) {
		console.warn('email-verification-delivery-notification-failed', error)
	}
}
