import { renderTransactionalEmail } from '#app/email/template.ts'
import { type PlatformFeedbackOutcomeStatus } from '#worker/platform-feedback/types.ts'

/**
 * Copy for every transactional email, kept free of runtime dependencies so the
 * messages can be rendered and inspected without a running worker.
 * `appBaseUrl` is the origin the Kody mark and other absolute assets are
 * loaded from.
 */

export function buildVerificationEmail(input: {
	appBaseUrl: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Verify your email to finish setting up Kody',
		preheader: 'One click and your assistant’s home is ready.',
		heading: 'Welcome to Kody',
		body: [
			'Kody is the home your AI assistant keeps — memory, keys, code, and automations, portable across every MCP host.',
			'Verify your email address to activate your account and get started.',
		],
		action: { label: 'Verify email address', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			'If you did not create a Kody account, you can safely ignore this email.',
	})
}

export function buildEmailChangeEmail(input: {
	appBaseUrl: string
	currentEmail: string
	newEmail: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Verify your new Kody email',
		preheader: `Confirm ${input.newEmail} as your Kody account email.`,
		heading: 'Confirm your new email address',
		body: [
			`We received a request to change your Kody account email from ${input.currentEmail} to ${input.newEmail}.`,
			'Verify the new address to make the change take effect.',
		],
		action: { label: 'Verify new email address', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		footnote:
			'If you did not request this change, you can safely ignore this email — your current address stays in place.',
	})
}

export function buildEmailClaimReleaseEmail(input: {
	appBaseUrl: string
	email: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Release this email from your Kody account',
		preheader: `Confirm you want to release ${input.email} so it can open a new Kody account.`,
		heading: 'Release this email address',
		body: [
			`${input.email} is still tied to your Kody account, so it cannot be used to create a second account.`,
			'Confirm this link to drop that claim. Your current login email and account identity stay the same.',
		],
		action: { label: 'Release this email', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		footnote:
			'If you did not ask to release this address, you can safely ignore this email — the claim stays in place.',
	})
}

export const userEntitlementWarningKinds = ['approaching', 'reached'] as const

export type UserEntitlementWarningKind =
	(typeof userEntitlementWarningKinds)[number]

export function buildUserEntitlementWarningEmail(input: {
	appBaseUrl: string
	billingUrl: string
	usageUrl: string
	kind: UserEntitlementWarningKind
	warnings: Array<{
		label: string
		current: number
		limit: number
		percentOfLimit: number
		whatCounts?: string
		howToReduce?: string
	}>
}) {
	const lines = input.warnings.map((warning) => {
		const percent = Math.round(warning.percentOfLimit * 100)
		const counts = [
			`${warning.label} — ${warning.current.toLocaleString('en-US')} of ${warning.limit.toLocaleString('en-US')} (${percent}%).`,
			warning.whatCounts,
			warning.howToReduce,
		].filter((part): part is string => Boolean(part && part.trim()))
		return counts.join(' ')
	})
	const copy = entitlementWarningCopy(input.kind)
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: copy.subject,
		preheader: copy.preheader,
		heading: copy.heading,
		body: [copy.intro, ...lines],
		action: { label: 'Review your plan', url: input.billingUrl },
		afterAction: [
			`You can also see every limit on your usage page: ${input.usageUrl}`,
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: copy.footnote,
	})
}

function entitlementWarningCopy(kind: UserEntitlementWarningKind) {
	switch (kind) {
		case 'approaching':
			return {
				subject: "You're approaching a Kody plan limit",
				preheader: 'One or more resources on your plan are over 80%.',
				heading: "You're getting close to a plan limit",
				intro:
					'Just a heads-up: one or more resources on your Kody account are over 80% of your current plan.',
				footnote:
					"You're receiving this because your account is approaching a plan limit.",
			}
		case 'reached':
			return {
				subject: "You've reached a Kody plan limit",
				preheader: 'One or more resources on your plan are at 100%.',
				heading: "You've hit a plan limit",
				intro:
					'Just a heads-up: one or more resources on your Kody account are at their current plan limit.',
				footnote:
					"You're receiving this because your account has reached a plan limit.",
			}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown entitlement warning kind: ${String(exhaustive)}`)
		}
	}
}

export function buildConnectAgentEmail(input: {
	appBaseUrl: string
	onboardingUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Connect your agent to Kody',
		preheader: 'One connection and your assistant has a home.',
		heading: 'Connect the agent you already use',
		body: [
			'Your email is verified. Next, connect Cursor, Claude, ChatGPT, or another MCP host so Kody can keep memory, secrets, and jobs for you.',
			'It takes a couple of minutes. After that, every agent you use can share the same home.',
		],
		action: { label: 'Connect your agent', url: input.onboardingUrl },
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you just verified a Kody account.",
	})
}

export function buildBillingSuccessEmail(input: {
	appBaseUrl: string
	billingUrl: string
	discordUrl: string
	planLabel: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: `You're on Kody ${input.planLabel}`,
		preheader: 'Thanks for paying for the volume you actually use.',
		heading: `Welcome to ${input.planLabel}`,
		body: [
			`Your Kody account is now on the ${input.planLabel} plan. Same factory, more room for jobs, workflows, and daily volume.`,
			'Join the Discord if you want help, examples, or to talk to other people building with Kody.',
		],
		action: { label: 'Join the Kody Discord', url: input.discordUrl },
		afterAction: [`You can manage billing anytime: ${input.billingUrl}`],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you subscribed to a Kody plan.",
	})
}

export function buildPaymentFailedEmail(input: {
	appBaseUrl: string
	billingUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Kody could not process your payment',
		preheader: 'Update your payment method to keep your paid plan.',
		heading: 'Your payment did not go through',
		body: [
			'Stripe could not charge the card on your Kody subscription. Update your payment method so your paid limits stay in place.',
		],
		action: { label: 'Update billing', url: input.billingUrl },
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because a Kody subscription payment failed.",
	})
}

export function buildPastDueEmail(input: {
	appBaseUrl: string
	billingUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody subscription is past due',
		preheader: 'Your paid plan is waiting on a successful payment.',
		heading: 'Your subscription is past due',
		body: [
			'Your Kody subscription is past due. Your paid limits stay in place while Stripe retries the charge, so nothing stops today — but update your payment method soon. If payment stays failed, the subscription ends and the account returns to the free plan.',
		],
		action: { label: 'Fix billing', url: input.billingUrl },
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because your Kody subscription is past due.",
	})
}

export function buildUserErrorRateEmail(input: {
	appBaseUrl: string
	activityUrl: string
	triagePackageUrl: string
	errorCount: number
	eventCount: number
}) {
	const percent =
		input.eventCount > 0
			? Math.round((input.errorCount / input.eventCount) * 100)
			: 0
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody runs are erroring more than usual',
		preheader: 'A look at the failures, and a package that can help.',
		heading: 'A few runs need attention',
		body: [
			`This month Kody recorded ${input.errorCount.toLocaleString('en-US')} errors across ${input.eventCount.toLocaleString('en-US')} runs (${percent}%).`,
			'Review the activity log, or fork Kent’s issue-triage package so a cloud agent can inspect the failures for you.',
		],
		action: { label: 'Review account activity', url: input.activityUrl },
		afterAction: [`Loop-safe Cursor triage package: ${input.triagePackageUrl}`],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because your Kody account crossed an error-rate threshold.",
	})
}

export function buildPlatformFeedbackOutcomeEmail(input: {
	appBaseUrl: string
	status: PlatformFeedbackOutcomeStatus
	summary: string
	userMessage?: string
}) {
	const copy = platformFeedbackOutcomeCopy(input.status)
	const userMessage = input.userMessage?.trim()
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: copy.subject,
		preheader: copy.preheader,
		heading: 'Thanks for your feedback',
		body: [
			copy.decision(input.summary.trim()),
			...(userMessage ? [userMessage] : []),
			'Thanks for taking the time to tell us. Notes like yours help us make Kody better.',
			'If you have more to share, tell your agent you want to send more Kody feedback.',
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you sent Kody platform feedback.",
	})
}

function platformFeedbackOutcomeCopy(status: PlatformFeedbackOutcomeStatus) {
	switch (status) {
		case 'resolved':
			return {
				subject: 'We resolved your Kody feedback',
				preheader: 'Thanks for telling us — here is what happened.',
				decision: (summary: string) =>
					`We resolved your feedback about "${summary}".`,
			}
		case 'dismissed':
			return {
				subject: 'An update on your Kody feedback',
				preheader: 'Thanks for telling us — here is what happened.',
				decision: (summary: string) =>
					`We reviewed your feedback about "${summary}" and closed it without a product change this time.`,
			}
		default: {
			const exhaustive: never = status
			throw new Error(
				`Unknown platform feedback outcome status: ${String(exhaustive)}`,
			)
		}
	}
}

export function buildPasswordResetEmail(input: {
	appBaseUrl: string
	resetUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Reset your Kody password',
		preheader: 'Use this link to choose a new password.',
		heading: 'Reset your password',
		body: [
			'We received a request to reset the password on your Kody account.',
			'Use the link below to choose a new one.',
		],
		action: { label: 'Reset password', url: input.resetUrl },
		afterAction: ['This link expires in 1 hour and can only be used once.'],
		footnote:
			'If you did not request a reset, you can safely ignore this email — your password stays unchanged.',
	})
}

export function buildPasswordResetConfirmedEmail(input: {
	appBaseUrl: string
	accountUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody password was reset',
		preheader: 'Your password changed. Extra sign-in methods were removed.',
		heading: 'Your password was reset',
		body: [
			'Your Kody password was changed using a reset link.',
			'Two-factor authentication, passkeys, and linked sign-in providers were removed; set them up again from your account.',
		],
		action: { label: 'Open account settings', url: input.accountUrl },
		footnote:
			'If you did not reset your password, sign in and change it again, then review your account security.',
	})
}
