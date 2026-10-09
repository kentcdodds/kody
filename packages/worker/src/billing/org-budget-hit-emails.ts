import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import {
	resolveTransactionalEmailConfig,
	type TransactionalEmailEnv,
} from '#app/email/sender-config.ts'
import {
	buildBudgetLimitMessage,
	type BudgetLimitErrorDetails,
	type BudgetLimitKind,
} from '#worker/entitlements/errors.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'

export const orgBudgetHitKvKeyPrefix = 'org-budget-hit:v1'
/** Long enough to cover a UTC month plus clock skew; refreshed keys expire naturally. */
export const orgBudgetHitClaimTtlSeconds = 45 * 24 * 60 * 60

export function orgBudgetHitKvKey(input: {
	orgId: string
	kind: BudgetLimitKind
	actorKey: string
	month: string
}) {
	return `${orgBudgetHitKvKeyPrefix}:${input.orgId}:${input.kind}:${input.actorKey}:${input.month}`
}

export function orgBudgetHitActorKey(input: {
	kind: BudgetLimitKind
	actorUserId: string | null
}) {
	if (input.kind === 'automation') return 'automation'
	const trimmed = input.actorUserId?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : 'unknown-member'
}

export function buildBudgetHitEmailContent(input: {
	details: BudgetLimitErrorDetails
	appBaseUrl: string
}) {
	const line = buildBudgetLimitMessage(input.details)
	const billingUrl = new URL('/account/billing', input.appBaseUrl).toString()
	const subject = 'Organization monthly budget reached'
	const text = `${line}\n\nManage billing: ${billingUrl}`
	const html = `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(billingUrl)}">Manage billing</a></p>`
	return { subject, text, html }
}

async function budgetHitAlreadyClaimed(input: {
	kv: KVNamespace
	key: string
}): Promise<'claimed' | 'unclaimed' | 'claim_check_failed'> {
	try {
		const existing = await input.kv.get(input.key)
		return existing ? 'claimed' : 'unclaimed'
	} catch (error) {
		console.warn('org-budget-hit-claim-failed', { phase: 'get', error })
		return 'claim_check_failed'
	}
}

async function putBudgetHitClaim(input: {
	kv: KVNamespace
	key: string
	claimedAt: string
}) {
	try {
		await input.kv.put(input.key, input.claimedAt, {
			expirationTtl: orgBudgetHitClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('org-budget-hit-claim-failed', { phase: 'put', error })
	}
}

/**
 * Notify org owners and billing members once per budget actor per UTC month.
 * Returns the number of recipient inboxes mailed.
 */
export async function sendBudgetHitEmail(input: {
	env: Pick<
		Env,
		| 'BUNDLE_ARTIFACTS_KV'
		| 'CLOUDFLARE_ACCOUNT_ID'
		| 'CLOUDFLARE_API_BASE_URL'
		| 'CLOUDFLARE_API_TOKEN'
	> &
		TransactionalEmailEnv
	db: D1Database
	orgId: string
	details: BudgetLimitErrorDetails
	actorUserId: string | null
	now?: Date
}): Promise<number> {
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) return 0

	const now = input.now ?? new Date()
	const month = utcMonthKey(now)
	const actorKey = orgBudgetHitActorKey({
		kind: input.details.kind,
		actorUserId: input.actorUserId,
	})
	const claimKey = orgBudgetHitKvKey({
		orgId: input.orgId,
		kind: input.details.kind,
		actorKey,
		month,
	})
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (kv) {
		const claimState = await budgetHitAlreadyClaimed({ kv, key: claimKey })
		if (claimState === 'claimed') return 0
	} else {
		return 0
	}

	const { subject, text, html } = buildBudgetHitEmailContent({
		details: input.details,
		appBaseUrl: emailConfig.appBaseUrl,
	})

	let anySent = false
	let recipientCount = 0
	try {
		recipientCount = await sendToOrgBillingRecipients({
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
					console.warn('org-budget-hit-email-skipped', {
						orgId: input.orgId,
						userId: recipient.userId,
						reason: sendResult.error ?? 'unconfigured',
					})
					return
				}
				anySent = true
			},
		})
	} catch (error) {
		console.warn('org-budget-hit-recipients-failed', error)
		return 0
	}

	if (!anySent) return 0

	// Org audit event write is deferred until P5 AUDIT_DB helpers exist on this branch.
	if (kv) {
		await putBudgetHitClaim({
			kv,
			key: claimKey,
			claimedAt: now.toISOString(),
		})
	}

	console.info('org-budget-hit-emailed', {
		orgId: input.orgId,
		kind: input.details.kind,
		month,
		actorKey,
	})
	return recipientCount
}
