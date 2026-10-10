import * as Sentry from '@sentry/cloudflare'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildPlatformFeedbackAcknowledgementEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import {
	isPlatformFeedbackSubmitterMailable,
	readPlatformFeedbackSubmitterMailTarget,
	releasePlatformFeedbackEmailClaim,
} from './submitter-mail.ts'
import { type PlatformFeedbackRecord } from './types.ts'

export const platformFeedbackAcknowledgementEmailKvKeyPrefix =
	'platform-feedback-acknowledgement-email:v1'
export const platformFeedbackAcknowledgementEmailClaimTtlSeconds =
	30 * 24 * 60 * 60

export function platformFeedbackAcknowledgementEmailKvKey(feedbackId: string) {
	return `${platformFeedbackAcknowledgementEmailKvKeyPrefix}:${feedbackId}`
}

function reportAcknowledgementSendFailure(input: {
	feedbackId: string
	error: unknown
}) {
	console.warn('platform-feedback-acknowledgement-email-send-failed', {
		feedbackId: input.feedbackId,
		error: input.error,
	})
	try {
		Sentry.captureException(input.error, {
			tags: {
				scope: 'platform-feedback-acknowledgement-email',
			},
			extra: {
				feedbackId: input.feedbackId,
			},
		})
	} catch (sentryError) {
		console.warn('platform-feedback-acknowledgement-email-sentry-failed', {
			feedbackId: input.feedbackId,
			error: sentryError,
		})
	}
}

/**
 * Send a one-time submit receipt to the feedback author. Same sender, recipient
 * guards, KV claim, and Cloudflare send path as the outcome email. Failures
 * never throw to the caller — they are logged and captured in Sentry.
 */
export async function sendPlatformFeedbackAcknowledgementEmail(input: {
	env: Env
	feedback: PlatformFeedbackRecord
}): Promise<boolean> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return false

	const submitter = await readPlatformFeedbackSubmitterMailTarget({
		db: input.env.APP_DB,
		stableUserId: input.feedback.submitterUserId,
	})
	if (!isPlatformFeedbackSubmitterMailable(submitter)) {
		return false
	}

	const key = platformFeedbackAcknowledgementEmailKvKey(input.feedback.id)
	if (await kv.get(key)) return false

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: platformFeedbackAcknowledgementEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('platform-feedback-acknowledgement-email-claim-failed', {
			feedbackId: input.feedback.id,
			error,
		})
		return false
	}

	const email = buildPlatformFeedbackAcknowledgementEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		feedbackId: input.feedback.id,
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
		await releasePlatformFeedbackEmailClaim(
			kv,
			key,
			'platform-feedback-acknowledgement-email-claim-release-failed',
		)
		reportAcknowledgementSendFailure({
			feedbackId: input.feedback.id,
			error,
		})
		return false
	}
	if (!sendResult.ok) {
		await releasePlatformFeedbackEmailClaim(
			kv,
			key,
			'platform-feedback-acknowledgement-email-claim-release-failed',
		)
		reportAcknowledgementSendFailure({
			feedbackId: input.feedback.id,
			error: new Error(sendResult.error ?? 'Cloudflare Email send failed.'),
		})
		return false
	}
	return true
}
