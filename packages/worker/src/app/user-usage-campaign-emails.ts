import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import {
	buildAdvocateReferralEmail,
	buildConnectAgentEmail,
	buildCoolingHomeEmail,
	buildKeepPackageEmail,
	buildSecondAgentEmail,
} from '#app/email/messages.ts'
import {
	normalizeReferralCode,
	referralSharePath,
} from '#universal/referral-program.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { portabilityGuideHref } from '#universal/onboarding-process.ts'
import {
	evaluateUsageCampaign,
	nextUsageCampaignRow,
	type UsageCampaignDecision,
} from '#worker/usage/campaign-evaluator.ts'
import {
	gatherUsageCampaignSnapshot,
	type UsageCampaignCandidate,
} from '#worker/usage/campaign-inputs.ts'
import {
	campaignRowToPersisted,
	claimUsageCampaignSend,
	readUsageCampaign,
	releaseUsageCampaignSend,
	upsertUsageCampaign,
} from '#worker/usage/campaign-ledger.ts'
import {
	campaignClientLabel,
	isPackagedSingleClientTrialCtaLive,
	usageCampaignSweepConcurrency,
	usageCampaignSweepLimit,
	type UsageCampaignMailTemplate,
} from '#worker/usage/campaign-states.ts'
import {
	isTipsEmailsOptedOut,
	mintTipsUnsubscribeUrl,
	tipsUnsubscribeHeaders,
	tipsUnsubscribeLabel,
} from '#worker/usage/tips-unsubscribe.ts'

export type UserUsageCampaignEmailResult =
	| { status: 'skipped'; reason: 'no_email_config' }
	| { status: 'no_sends'; evaluatedUsers: number }
	| {
			status: 'notified'
			evaluatedUsers: number
			emailedUsers: number
			emailsSent: number
	  }

export function buildUsageCampaignEmail(input: {
	appBaseUrl: string
	template: UsageCampaignMailTemplate
	clientLabel: string
	trialGiftLive: boolean
	shareUrl?: string
	unsubscribe?: { label: string; url: string }
}) {
	const onboardingUrl = new URL('/onboarding', input.appBaseUrl).toString()
	const portabilityUrl = new URL(
		portabilityGuideHref,
		input.appBaseUrl,
	).toString()
	const billingUrl = new URL('/account/billing', input.appBaseUrl).toString()
	switch (input.template) {
		case 'verified_no_mcp':
			return buildConnectAgentEmail({
				appBaseUrl: input.appBaseUrl,
				onboardingUrl,
				unsubscribe: input.unsubscribe,
			})
		case 'connected_no_package':
			return buildKeepPackageEmail({
				appBaseUrl: input.appBaseUrl,
				onboardingUrl,
				clientLabel: input.clientLabel,
				unsubscribe: input.unsubscribe,
			})
		case 'packaged_single_client':
			return buildSecondAgentEmail({
				appBaseUrl: input.appBaseUrl,
				portabilityUrl,
				trialUrl: input.trialGiftLive ? billingUrl : undefined,
				unsubscribe: input.unsubscribe,
			})
		case 'cooling':
			return buildCoolingHomeEmail({
				appBaseUrl: input.appBaseUrl,
				onboardingUrl,
				unsubscribe: input.unsubscribe,
			})
		case 'advocate_referral_testimonial':
			if (input.shareUrl == null) {
				throw new Error('Advocate campaign mail requires a referral share URL.')
			}
			return buildAdvocateReferralEmail({
				appBaseUrl: input.appBaseUrl,
				shareUrl: input.shareUrl,
				unsubscribe: input.unsubscribe,
			})
		default: {
			const exhaustive: never = input.template
			throw new Error(`Unknown campaign template: ${String(exhaustive)}`)
		}
	}
}

function campaignReferralShareUrl(
	appBaseUrl: string,
	username: string | null | undefined,
) {
	const code = normalizeReferralCode(username)
	if (!code) return null
	return new URL(referralSharePath(code), appBaseUrl).toString()
}

export async function sendUserUsageCampaignEmails(input: {
	env: Env
	now?: Date
}): Promise<UserUsageCampaignEmailResult> {
	const now = input.now ?? new Date()
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) {
		return { status: 'skipped', reason: 'no_email_config' }
	}

	const candidates = await listUsersForUsageCampaignSweep(
		input.env.APP_DB,
		usageCampaignSweepLimit,
	)
	if (candidates.length === 0) {
		return { status: 'no_sends', evaluatedUsers: 0 }
	}

	let emailedUsers = 0
	let emailsSent = 0
	await mapWithConcurrency(
		candidates,
		usageCampaignSweepConcurrency,
		async (user) => {
			const sent = await evaluateAndMaybeSendOneUser({
				env: input.env,
				emailConfig,
				user,
				now,
			})
			if (!sent) return
			emailedUsers += 1
			emailsSent += 1
		},
	)

	if (emailedUsers === 0) {
		return { status: 'no_sends', evaluatedUsers: candidates.length }
	}
	console.info('user-usage-campaign-emailed', {
		evaluatedUsers: candidates.length,
		emailedUsers,
		emailsSent,
	})
	return {
		status: 'notified',
		evaluatedUsers: candidates.length,
		emailedUsers,
		emailsSent,
	}
}

/**
 * Open the VerifiedNoMcp event series without claiming a send. Used when
 * verify-time connect-agent mail fails closed so the hourly sweep can retry
 * instead of first-observing the user as seed.
 */
export async function openVerifiedNoMcpCampaignEvent(input: {
	env: Env
	userId: string
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	if (!input.env.APP_DB) return false
	try {
		const existing = await readUsageCampaign(input.env.APP_DB, input.userId)
		const persisted = campaignRowToPersisted(existing)
		if (persisted.state != null && persisted.state !== 'VerifiedNoMcp') {
			return false
		}
		if (persisted.origin === 'event' && persisted.sendCount > 0) {
			return false
		}
		await upsertUsageCampaign({
			db: input.env.APP_DB,
			userId: input.userId,
			state: 'VerifiedNoMcp',
			enteredAt: persisted.enteredAt ?? now.toISOString(),
			sendCount: persisted.sendCount,
			lastSentAt: persisted.lastSentAt,
			origin: 'event',
			coolingTerminal: persisted.coolingTerminal,
			everActivated: persisted.everActivated,
			now,
		})
		return true
	} catch (error) {
		console.warn('usage-campaign-verify-open-failed', error)
		return false
	}
}

/**
 * Verify-time VerifiedNoMcp send 1. Records the campaign row as event-origin
 * so later hourly nudges can send at most one more mail, then stop.
 */
export async function recordVerifiedNoMcpCampaignSend(input: {
	env: Env
	userId: string
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	if (!input.env.APP_DB) return false
	try {
		const existing = await readUsageCampaign(input.env.APP_DB, input.userId)
		const persisted = campaignRowToPersisted(existing)
		if (persisted.state != null && persisted.state !== 'VerifiedNoMcp') {
			return false
		}
		const claimed = await claimUsageCampaignSend({
			db: input.env.APP_DB,
			userId: input.userId,
			state: 'VerifiedNoMcp',
			template: 'verified_no_mcp',
			sendIndex: 1,
			now,
		})
		if (!claimed) return false
		await upsertUsageCampaign({
			db: input.env.APP_DB,
			userId: input.userId,
			state: 'VerifiedNoMcp',
			enteredAt: persisted.enteredAt ?? now.toISOString(),
			sendCount: Math.max(persisted.sendCount, 1),
			lastSentAt: now.toISOString(),
			origin: 'event',
			coolingTerminal: persisted.coolingTerminal,
			everActivated: persisted.everActivated,
			now,
		})
		return true
	} catch (error) {
		console.warn('usage-campaign-verify-record-failed', error)
		return false
	}
}

export async function listUsersForUsageCampaignSweep(
	db: D1Database,
	limit: number,
) {
	const result = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, u.email, u.email_verified_at,
			        u.first_mcp_connected_at, u.first_saved_package_at,
			        u.first_execute_at, u.mcp_client_name, u.last_active_at,
			        u.second_agent_standard_gift_granted_at,
			        u.second_agent_standard_gift_expires_at,
			        u.referral_standard_credit_expires_at,
			        u.plan, u.stripe_plan, u.entitlement_ladder
			 FROM users u
			 LEFT JOIN user_usage_campaigns c ON c.user_id = u.stable_user_id
			 WHERE u.email_verified_at IS NOT NULL
			   AND u.deleting_at IS NULL
			   AND u.suspended_at IS NULL
			   AND u.email_outbound_paused_at IS NULL
			   AND u.account_type = 'person'
			 ORDER BY COALESCE(c.last_evaluated_at, '') ASC, u.stable_user_id ASC
			 LIMIT ?`,
		)
		.bind(limit)
		.all<UsageCampaignCandidate>()
	return result.results ?? []
}

async function evaluateAndMaybeSendOneUser(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: UsageCampaignCandidate
	now: Date
}): Promise<boolean> {
	try {
		const existing = await readUsageCampaign(
			input.env.APP_DB,
			input.user.stable_user_id,
		)
		const persisted = campaignRowToPersisted(existing)
		const snapshot = await gatherUsageCampaignSnapshot({
			env: input.env,
			user: input.user,
			now: input.now,
		})
		const decision = evaluateUsageCampaign(snapshot, persisted)
		if (decision.action !== 'send') {
			await persistDecision({
				db: input.env.APP_DB,
				userId: input.user.stable_user_id,
				decision,
				persisted,
				now: input.now,
				sent: false,
			})
			return false
		}
		if (
			await isTipsEmailsOptedOut({
				db: input.env.APP_DB,
				userId: input.user.stable_user_id,
			})
		) {
			await persistDecision({
				db: input.env.APP_DB,
				userId: input.user.stable_user_id,
				decision,
				persisted,
				now: input.now,
				sent: false,
			})
			return false
		}
		return await sendClaimedCampaignEmail({
			env: input.env,
			emailConfig: input.emailConfig,
			user: input.user,
			decision,
			persisted,
			now: input.now,
		})
	} catch (error) {
		console.warn('usage-campaign-user-failed', {
			userId: input.user.stable_user_id,
			error,
		})
		return false
	}
}

async function sendClaimedCampaignEmail(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: UsageCampaignCandidate
	decision: UsageCampaignDecision
	persisted: ReturnType<typeof campaignRowToPersisted>
	now: Date
}): Promise<boolean> {
	const template = input.decision.template
	const sendIndex = input.decision.sendIndex
	if (template == null || sendIndex == null) return false

	const claimed = await claimUsageCampaignSend({
		db: input.env.APP_DB,
		userId: input.user.stable_user_id,
		state: input.decision.state,
		template,
		sendIndex,
		now: input.now,
	})
	if (!claimed) {
		// Ledger UNIQUE already holds this send (overlapping sweep or a
		// later re-entry after LimitAware). Persist evaluation so
		// last_evaluated_at moves and the sweep can rotate. sent:false
		// plus the upsert MAX/keep rules cannot clobber a concurrent
		// winner's send_count or last_sent_at.
		await persistDecision({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			decision: input.decision,
			persisted: input.persisted,
			now: input.now,
			sent: false,
		})
		return false
	}

	const unsubscribe = await mintCampaignUnsubscribe({
		env: input.env,
		appBaseUrl: input.emailConfig.appBaseUrl,
		userId: input.user.stable_user_id,
	})
	if (!unsubscribe) {
		await releaseUsageCampaignSend({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			state: input.decision.state,
			sendIndex,
		})
		return false
	}
	const shareUrl = campaignReferralShareUrl(
		input.emailConfig.appBaseUrl,
		input.user.username,
	)
	if (template === 'advocate_referral_testimonial' && shareUrl == null) {
		await releaseUsageCampaignSend({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			state: input.decision.state,
			sendIndex,
		})
		return false
	}
	const email = buildUsageCampaignEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		template,
		clientLabel: campaignClientLabel(input.user.mcp_client_name),
		trialGiftLive: isPackagedSingleClientTrialCtaLive({
			grantedAt: input.user.second_agent_standard_gift_granted_at,
			expiresAt: input.user.second_agent_standard_gift_expires_at,
			now: input.now,
		}),
		shareUrl: shareUrl ?? undefined,
		unsubscribe: unsubscribe?.unsubscribe,
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
				headers: unsubscribe?.headers,
			},
		)
	} catch (error) {
		console.warn('usage-campaign-send-failed', {
			state: input.decision.state,
			error,
		})
		await releaseUsageCampaignSend({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			state: input.decision.state,
			sendIndex,
		})
		return false
	}
	if (!sendResult.ok) {
		console.warn('usage-campaign-send-skipped', {
			state: input.decision.state,
			reason: sendResult.error ?? 'unconfigured',
		})
		await releaseUsageCampaignSend({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			state: input.decision.state,
			sendIndex,
		})
		return false
	}

	await persistDecision({
		db: input.env.APP_DB,
		userId: input.user.stable_user_id,
		decision: input.decision,
		persisted: input.persisted,
		now: input.now,
		sent: true,
	})
	return true
}

async function persistDecision(input: {
	db: D1Database
	userId: string
	decision: UsageCampaignDecision
	persisted: ReturnType<typeof campaignRowToPersisted>
	now: Date
	sent: boolean
}) {
	const row = nextUsageCampaignRow({
		decision: input.decision,
		persisted: input.persisted,
		now: input.now,
		sent: input.sent,
	})
	await upsertUsageCampaign({
		db: input.db,
		userId: input.userId,
		state: row.state,
		enteredAt: row.enteredAt,
		sendCount: row.sendCount,
		lastSentAt: row.lastSentAt,
		origin: row.origin,
		coolingTerminal: row.coolingTerminal,
		everActivated: row.everActivated,
		firstActivatedAt: row.firstActivatedAt,
		advocateSentAt: row.advocateSentAt,
		now: input.now,
	})
}

async function mintCampaignUnsubscribe(input: {
	env: Env
	appBaseUrl: string
	userId: string
}) {
	try {
		const url = await mintTipsUnsubscribeUrl({
			env: input.env,
			appBaseUrl: input.appBaseUrl,
			userId: input.userId,
		})
		return {
			unsubscribe: { label: tipsUnsubscribeLabel, url },
			headers: tipsUnsubscribeHeaders(url),
		}
	} catch (error) {
		console.warn('usage-campaign-unsubscribe-mint-failed', error)
		return null
	}
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}
