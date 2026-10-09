import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { listOrgBillingRecipientUserIds } from '#worker/orgs/billing.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type OrgBillingRecipient = {
	userId: string
	email: string
}

/**
 * Resolve invoice-style recipients (owners and billing role) with deliverable
 * email addresses.
 */
async function resolveBillingRecipientUserIds(
	db: D1Database,
	orgId: string,
): Promise<Array<string>> {
	const userIds = await listOrgBillingRecipientUserIds(db, orgId)
	if (userIds.length > 0) return userIds
	// Personal orgs always have an owner user id equal to org id; tests and
	// pre-membership rows may omit org_memberships.
	const personalOwner = await db
		.prepare(
			`SELECT stable_user_id
			 FROM users
			 WHERE stable_user_id = ?
			   AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ stable_user_id: string }>()
	return personalOwner ? [orgId] : []
}

export async function loadOrgBillingRecipientEmails(
	db: D1Database,
	orgId: string,
): Promise<Array<OrgBillingRecipient>> {
	const userIds = await resolveBillingRecipientUserIds(db, orgId)
	if (userIds.length === 0) return []
	const placeholders = userIds.map(() => '?').join(', ')
	const { results } = await db
		.prepare(
			`SELECT stable_user_id AS user_id, email
			 FROM users
			 WHERE stable_user_id IN (${placeholders})
			   AND deleting_at IS NULL
			   AND email IS NOT NULL
			   AND TRIM(email) != ''${andLiveDeletedAtSql()}`,
		)
		.bind(...userIds)
		.all<{ user_id: string; email: string }>()
	const byId = new Map(
		results.map((row) => [row.user_id, row.email.trim()] as const),
	)
	const recipients: Array<OrgBillingRecipient> = []
	for (const userId of userIds) {
		const email = byId.get(userId)
		if (!email) continue
		recipients.push({ userId, email })
	}
	return recipients
}

/**
 * Fan out one billing notice to every org billing recipient. Throws when no
 * recipient can be reached so misconfigured orgs fail loudly.
 */
export async function sendToOrgBillingRecipients(input: {
	db: D1Database
	orgId: string
	sendOne: (recipient: OrgBillingRecipient) => Promise<void>
}): Promise<number> {
	const recipients = await loadOrgBillingRecipientEmails(input.db, input.orgId)
	if (recipients.length === 0) {
		throw new Error(
			`No billing recipients with email for org ${input.orgId.trim() || '(empty)'}`,
		)
	}
	for (const recipient of recipients) {
		await input.sendOne(recipient)
	}
	return recipients.length
}

export async function sendSeatChangeEmail(input: {
	env: Env
	db: D1Database
	orgId: string
	slug: string
	previousQuantity: number
	nextQuantity: number
}): Promise<number> {
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) return 0
	const subject = `Organization @${input.slug} seat count changed`
	const line = `Organization @${input.slug} seat count changed from ${input.previousQuantity} to ${input.nextQuantity}.`
	const billingUrl = new URL(
		'/account/billing',
		emailConfig.appBaseUrl,
	).toString()
	const text = `${line}\n\nManage billing: ${billingUrl}`
	const html = `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(billingUrl)}">Manage billing</a></p>`

	return await sendToOrgBillingRecipients({
		db: input.db,
		orgId: input.orgId,
		sendOne: async (recipient) => {
			const sendResult = await sendCloudflareEmail(
				{
					accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
					apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
					apiToken: input.env.CLOUDFLARE_API_TOKEN,
				},
				{
					to: recipient.email,
					from: emailConfig.fromEmail,
					subject,
					html,
					text,
				},
			)
			if (!sendResult.ok) {
				console.warn('org-seat-change-email-skipped', {
					orgId: input.orgId,
					userId: recipient.userId,
					reason: sendResult.error ?? 'unconfigured',
				})
			}
		},
	})
}
