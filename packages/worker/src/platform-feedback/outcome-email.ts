import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildPlatformFeedbackOutcomeEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import {
	platformFeedbackOutcomeStatuses,
	type PlatformFeedbackOutcomeStatus,
	type PlatformFeedbackRecord,
	type PlatformFeedbackStatus,
} from './types.ts'

export const platformFeedbackOutcomeEmailKvKeyPrefix =
	'platform-feedback-outcome-email:v1'
export const platformFeedbackOutcomeEmailClaimTtlSeconds = 30 * 24 * 60 * 60

export function platformFeedbackOutcomeEmailKvKey(input: {
	feedbackId: string
	status: PlatformFeedbackOutcomeStatus
}) {
	return `${platformFeedbackOutcomeEmailKvKeyPrefix}:${input.feedbackId}:${input.status}`
}

export function isPlatformFeedbackOutcomeStatus(
	status: PlatformFeedbackStatus,
): status is PlatformFeedbackOutcomeStatus {
	return (platformFeedbackOutcomeStatuses as ReadonlyArray<string>).includes(
		status,
	)
}

export function shouldSendPlatformFeedbackOutcomeEmail(input: {
	didChangeStatus: boolean
	status: PlatformFeedbackStatus
}): input is { didChangeStatus: true; status: PlatformFeedbackOutcomeStatus } {
	return input.didChangeStatus && isPlatformFeedbackOutcomeStatus(input.status)
}

type SubmitterMailTarget = {
	email: string
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
}

async function readSubmitterMailTarget(input: {
	db: D1Database
	stableUserId: string
}): Promise<SubmitterMailTarget | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!stableUserId) return null
	const row = await input.db
		.prepare(
			`SELECT email, suspended_at, email_outbound_paused_at FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{
			email: string | null
			suspended_at: string | null
			email_outbound_paused_at: string | null
		}>()
	if (!row) return null
	return {
		email: row.email?.trim() ?? '',
		suspendedAt: row.suspended_at,
		emailOutboundPausedAt: row.email_outbound_paused_at,
	}
}

async function releaseEmailClaim(kv: KVNamespace, key: string) {
	try {
		await kv.delete(key)
	} catch (error) {
		console.warn('platform-feedback-outcome-email-claim-release-failed', {
			key,
			error,
		})
	}
}

export async function sendPlatformFeedbackOutcomeEmail(input: {
	env: Env
	feedback: PlatformFeedbackRecord
	status: PlatformFeedbackOutcomeStatus
	userMessage?: string
}): Promise<boolean> {
	if (input.feedback.status !== input.status) return false

	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return false

	const submitter = await readSubmitterMailTarget({
		db: input.env.APP_DB,
		stableUserId: input.feedback.submitterUserId,
	})
	if (
		!submitter?.email ||
		submitter.suspendedAt ||
		submitter.emailOutboundPausedAt
	) {
		return false
	}

	const key = platformFeedbackOutcomeEmailKvKey({
		feedbackId: input.feedback.id,
		status: input.status,
	})
	if (await kv.get(key)) return false

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: platformFeedbackOutcomeEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('platform-feedback-outcome-email-claim-failed', {
			feedbackId: input.feedback.id,
			status: input.status,
			error,
		})
		return false
	}

	const email = buildPlatformFeedbackOutcomeEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		status: input.status,
		summary: input.feedback.summary,
		userMessage: input.userMessage,
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
				to: submitter.email,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		console.warn('platform-feedback-outcome-email-send-failed', {
			feedbackId: input.feedback.id,
			status: input.status,
			error,
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	if (!sendResult.ok) {
		console.warn('platform-feedback-outcome-email-send-skipped', {
			feedbackId: input.feedback.id,
			status: input.status,
			reason: sendResult.error ?? 'unconfigured',
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	return true
}
