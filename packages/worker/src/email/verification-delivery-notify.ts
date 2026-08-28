import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import { type RecordedTransactionalDelivery } from './verification-delivery.ts'

type VerificationNotifyEnv = Pick<
	Env,
	| 'APP_DB'
	| 'APP_BASE_URL'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
>

/**
 * Best-effort operator notification when signup/verify mail hits a terminal
 * delivery failure. A send failure must never fail delivery-event
 * processing — the user row already carries the bounce.
 */
export async function notifyAdminsOfVerificationDeliveryFailure(input: {
	env: VerificationNotifyEnv
	event: RecordedTransactionalDelivery
}) {
	try {
		const systemDomain = getSystemEmailDomain(input.env)
		if (!systemDomain) return
		const [admins, user] = await Promise.all([
			input.env.APP_DB.prepare(
				`SELECT u.email, u.username FROM users u
				 INNER JOIN user_roles ur ON ur.user_id = u.id
				 INNER JOIN roles r ON r.id = ur.role_id
				 WHERE r.name = 'admin'
				 ORDER BY u.id ASC`,
			).all<{ email: string; username: string }>(),
			input.env.APP_DB.prepare(
				`SELECT username, email, stable_user_id FROM users WHERE id = ?`,
			)
				.bind(input.event.userId)
				.first<{
					username: string
					email: string
					stable_user_id: string
				}>(),
		])
		const recipients = (admins.results ?? []).map((row) => row.email)
		if (recipients.length === 0) return
		const username = user?.username ?? 'unknown'
		const recipient = redactEmailRecipient(user?.email ?? input.event.recipient)
		const adminUsersPath = user?.stable_user_id
			? `/admin/users/${user.stable_user_id}`
			: '/admin/users'
		const reason =
			input.event.class === 'sender_block'
				? `${input.event.status} (sender domain/IP block)`
				: input.event.status
		const text = [
			`Verification email ${reason} for user "${username}" (${recipient}).`,
			'The account is still unverified. Do not resend through kody.codes if this is a sender-domain block — mark the email verified after ownership is proven, or mint a verify link and send it over another path.',
			`Review the account at ${joinAppUrl({ env: input.env, path: adminUsersPath })}.`,
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
