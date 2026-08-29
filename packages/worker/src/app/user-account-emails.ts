import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import {
	buildBillingSuccessEmail,
	buildConnectAgentEmail,
	buildPastDueEmail,
	buildPaymentFailedEmail,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'

export const userAccountEmailKvKeyPrefix = 'account-email-user:v1'
export const userAccountEmailClaimTtlSeconds = 30 * 24 * 60 * 60

export type UserAccountEmailKind =
	| 'connect_agent'
	| 'billing_success'
	| 'payment_failed'
	| 'past_due'

export function userAccountEmailKvKey(input: {
	userId: string
	kind: UserAccountEmailKind
	suffix?: string
}) {
	const base = `${userAccountEmailKvKeyPrefix}:${input.userId}:${input.kind}`
	return input.suffix ? `${base}:${input.suffix}` : base
}

type EmailConfig = { appBaseUrl: string; fromEmail: string }

async function claimAndSend(input: {
	env: Env
	to: string
	userId: string
	kind: UserAccountEmailKind
	suffix?: string
	build: (config: EmailConfig) => {
		subject: string
		html: string
		text: string
	}
}): Promise<boolean> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return false

	const key = userAccountEmailKvKey({
		userId: input.userId,
		kind: input.kind,
		suffix: input.suffix,
	})
	if (await kv.get(key)) return false

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: userAccountEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('user-account-email-claim-failed', {
			kind: input.kind,
			error,
		})
		return false
	}

	const email = input.build(emailConfig)
	let sendResult: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		sendResult = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: input.to,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		console.warn('user-account-email-send-failed', {
			kind: input.kind,
			error,
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	if (!sendResult.ok) {
		console.warn('user-account-email-send-skipped', {
			kind: input.kind,
			reason: sendResult.error ?? 'unconfigured',
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	return true
}

async function releaseEmailClaim(kv: KVNamespace, key: string) {
	try {
		await kv.delete(key)
	} catch (error) {
		console.warn('user-account-email-claim-release-failed', { key, error })
	}
}

export async function sendConnectAgentEmail(input: {
	env: Env
	email: string
	userId: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'connect_agent',
		build: (config) =>
			buildConnectAgentEmail({
				appBaseUrl: config.appBaseUrl,
				onboardingUrl: new URL('/onboarding', config.appBaseUrl).toString(),
			}),
	})
}

export async function sendBillingSuccessEmail(input: {
	env: Env
	email: string
	userId: string
	planLabel: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'billing_success',
		suffix: input.planLabel.toLowerCase(),
		build: (config) =>
			buildBillingSuccessEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: new URL('/account/billing', config.appBaseUrl).toString(),
				discordUrl: kodyDiscordInviteUrl,
				planLabel: input.planLabel,
			}),
	})
}

export async function sendPaymentFailedEmail(input: {
	env: Env
	email: string
	userId: string
	day: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'payment_failed',
		suffix: input.day,
		build: (config) =>
			buildPaymentFailedEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: new URL('/account/billing', config.appBaseUrl).toString(),
			}),
	})
}

export async function sendPastDueEmail(input: {
	env: Env
	email: string
	userId: string
	day: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'past_due',
		suffix: input.day,
		build: (config) =>
			buildPastDueEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: new URL('/account/billing', config.appBaseUrl).toString(),
			}),
	})
}
