import { renderTransactionalEmail } from '#app/email/template.ts'

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

export function buildUserEntitlementWarningEmail(input: {
	appBaseUrl: string
	billingUrl: string
	usageUrl: string
	warnings: Array<{
		label: string
		current: number
		limit: number
		percentOfLimit: number
	}>
}) {
	const lines = input.warnings.map((warning) => {
		const percent = Math.round(warning.percentOfLimit * 100)
		return `${warning.label} — ${warning.current.toLocaleString('en-US')} of ${warning.limit.toLocaleString('en-US')} (${percent}%).`
	})
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: "You're approaching a Kody plan limit",
		preheader: 'One or more resources on your plan are over 80%.',
		heading: "You're getting close to a plan limit",
		body: [
			'Just a heads-up: one or more resources on your Kody account are over 80% of your current plan.',
			...lines,
		],
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
		footnote:
			"You're receiving this because your account is approaching a plan limit.",
	})
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
