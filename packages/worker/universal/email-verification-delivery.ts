export const emailVerificationDeliveryStatusValues = [
	'accepted',
	'delivered',
	'deferred',
	'bounced',
	'failed',
	'rejected',
	'complained',
] as const

export type EmailVerificationDeliveryStatus =
	(typeof emailVerificationDeliveryStatusValues)[number]

export const emailVerificationDeliveryClassValues = [
	'sender_block',
	'other',
] as const

export type EmailVerificationDeliveryClass =
	(typeof emailVerificationDeliveryClassValues)[number]

export type EmailVerificationDelivery = {
	status: EmailVerificationDeliveryStatus
	class: EmailVerificationDeliveryClass | null
	at: string | null
}

export const emailVerificationSenderBlockMessage =
	'Your mailbox provider rejected mail from kody.codes (sender domain or IP block). Resending the same message will not get through and can make delivery worse. Contact support or use a different email address.'

export const emailVerificationDeliveryFailedMessage =
	'The verification email could not be delivered. You can try resending, or contact support if it keeps failing.'

export function isEmailVerificationDeliveryStatus(
	value: string | null | undefined,
): value is EmailVerificationDeliveryStatus {
	return (
		typeof value === 'string' &&
		(emailVerificationDeliveryStatusValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

export function isEmailVerificationDeliveryClass(
	value: string | null | undefined,
): value is EmailVerificationDeliveryClass {
	return (
		typeof value === 'string' &&
		(emailVerificationDeliveryClassValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

export function parseEmailVerificationDelivery(input: {
	status?: string | null
	class?: string | null
	at?: string | null
}): EmailVerificationDelivery | null {
	if (!isEmailVerificationDeliveryStatus(input.status)) return null
	return {
		status: input.status,
		class: isEmailVerificationDeliveryClass(input.class) ? input.class : null,
		at: typeof input.at === 'string' && input.at.trim() ? input.at : null,
	}
}

export function isEmailVerificationResendBlocked(
	delivery: EmailVerificationDelivery | null,
) {
	return delivery?.class === 'sender_block'
}

export function describeEmailVerificationDelivery(
	delivery: EmailVerificationDelivery | null,
): {
	headline: string | null
	detail: string | null
	canResend: boolean
	tone: 'info' | 'error'
} {
	if (!delivery) {
		return {
			headline: null,
			detail: null,
			canResend: true,
			tone: 'info',
		}
	}
	if (delivery.class === 'sender_block') {
		return {
			headline: 'Verification email blocked',
			detail: emailVerificationSenderBlockMessage,
			canResend: false,
			tone: 'error',
		}
	}
	switch (delivery.status) {
		case 'bounced':
		case 'failed':
		case 'rejected':
			return {
				headline: 'Verification email was not delivered',
				detail: emailVerificationDeliveryFailedMessage,
				canResend: true,
				tone: 'error',
			}
		case 'complained':
			return {
				headline: 'Verification email was marked as spam',
				detail: emailVerificationDeliveryFailedMessage,
				canResend: true,
				tone: 'error',
			}
		case 'delivered':
			return {
				headline: 'Verification email delivered',
				detail:
					'The message reached your mailbox. Check your inbox and spam folder for the link.',
				canResend: true,
				tone: 'info',
			}
		case 'deferred':
			return {
				headline: 'Verification email delayed',
				detail:
					'Your mailbox provider delayed the message. Wait a bit, or resend if it still has not arrived.',
				canResend: true,
				tone: 'info',
			}
		case 'accepted':
			return {
				headline: null,
				detail: null,
				canResend: true,
				tone: 'info',
			}
		default: {
			const exhaustive: never = delivery.status
			void exhaustive
			return {
				headline: null,
				detail: null,
				canResend: true,
				tone: 'info',
			}
		}
	}
}
