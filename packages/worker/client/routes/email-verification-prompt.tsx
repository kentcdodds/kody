import { css } from 'remix/component'
import {
	describeEmailVerificationDelivery,
	parseEmailVerificationDelivery,
	type EmailVerificationDelivery,
	type EmailVerificationDeliveryIndicator,
} from '#universal/email-verification-delivery.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { on } from '#client/event-mixin.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'

export { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'

const resendVerificationApiPath = '/account/resend-verification.json'
const emailVerificationDeliveryApiPath =
	'/account/email-verification-delivery.json'

export type ResendVerificationResult =
	| { ok: true; message: string }
	| { ok: false; message: string; unauthorized?: boolean }

export type EmailVerificationDeliveryPollResult =
	| {
			ok: true
			emailVerified: boolean
			delivery: EmailVerificationDelivery | null
	  }
	| { ok: false; unauthorized?: boolean }

export async function requestResendVerification(
	redirectTo?: string | null,
): Promise<ResendVerificationResult> {
	const safeRedirectTo = normalizeRedirectTo(redirectTo)
	const response = await fetch(resendVerificationApiPath, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify(safeRedirectTo ? { redirectTo: safeRedirectTo } : {}),
	})
	if (response.status === 401) {
		return {
			ok: false,
			message: 'Sign in again to resend the verification email.',
			unauthorized: true,
		}
	}
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		message?: string
		error?: string
	} | null
	if (!response.ok || !payload?.ok) {
		return {
			ok: false,
			message:
				typeof payload?.error === 'string'
					? payload.error
					: 'Unable to resend the verification email.',
		}
	}
	return {
		ok: true,
		message:
			typeof payload.message === 'string'
				? payload.message
				: 'Verification email sent. Check your inbox.',
	}
}

/**
 * Session-only delivery poll. Does not accept an email address — the server
 * keys off the signed-in user so signup cannot probe other inboxes.
 */
export async function fetchEmailVerificationDelivery(
	signal?: AbortSignal,
): Promise<EmailVerificationDeliveryPollResult> {
	try {
		const response = await fetch(emailVerificationDeliveryApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		})
		if (response.status === 401) {
			return { ok: false, unauthorized: true }
		}
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean
			emailVerified?: boolean
			delivery?: {
				status?: string | null
				class?: string | null
				at?: string | null
			} | null
		} | null
		if (!response.ok || !payload?.ok) {
			return { ok: false }
		}
		return {
			ok: true,
			emailVerified: payload.emailVerified === true,
			delivery:
				payload.emailVerified === true
					? null
					: parseEmailVerificationDelivery(
							payload.delivery && typeof payload.delivery === 'object'
								? {
										status: payload.delivery.status,
										class: payload.delivery.class,
										at: payload.delivery.at,
									}
								: {},
						),
		}
	} catch {
		return { ok: false }
	}
}

type EmailVerificationPromptOptions = {
	email?: string | null
	title?: string
	description: string
	delivery?: EmailVerificationDelivery | null
	resendStatus: 'idle' | 'sending'
	resendMessage: string | null
	resendTone?: 'error' | 'info'
	onResend: () => void
	continueLabel?: string | null
	onContinue?: (() => void) | null
	secondaryHref?: string | null
	secondaryLabel?: string | null
}

function renderDeliveryIndicator(
	indicator: EmailVerificationDeliveryIndicator,
) {
	const label =
		indicator === 'waiting'
			? 'Waiting for delivery confirmation'
			: indicator === 'delivered'
				? 'Delivered to mailbox'
				: indicator === 'delayed'
					? 'Delivery delayed'
					: 'Delivery failed'
	const iconColor =
		indicator === 'failed'
			? colors.danger
			: indicator === 'delayed'
				? colors.warningText
				: colors.primary
	return (
		<p
			role="status"
			data-testid="email-verification-delivery-indicator"
			data-indicator={indicator}
			mix={css({
				display: 'flex',
				alignItems: 'center',
				gap: spacing.sm,
				margin: 0,
				color: iconColor,
				fontSize: '0.95rem',
			})}
		>
			<span
				aria-hidden="true"
				mix={css(
					indicator === 'waiting'
						? deliverySpinnerCss
						: {
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '1.1rem',
								height: '1.1rem',
								fontWeight: 700,
								lineHeight: 1,
							},
				)}
			>
				{indicator === 'waiting'
					? null
					: indicator === 'delivered'
						? '✓'
						: indicator === 'delayed'
							? '…'
							: '!'}
			</span>
			<span>{label}</span>
		</p>
	)
}

/**
 * Shared verify-email callout used by pending signup, account, and the MCP
 * authorize gate. Keeps resend/continue actions consistent.
 */
export function renderEmailVerificationPrompt(
	options: EmailVerificationPromptOptions,
) {
	const title = options.title ?? 'Verify your email'
	const delivery = describeEmailVerificationDelivery(options.delivery ?? null)
	const promptTitle = delivery.headline ?? title
	const promptDescription = delivery.detail ?? options.description
	const canResend = delivery.canResend
	const primaryButtonCss = getPrimaryButtonCss({
		size: 'md',
		weight: 'semibold',
	})
	const secondaryButtonCss = getSecondaryButtonCss({
		size: 'md',
		weight: 'semibold',
	})

	return (
		<section
			aria-label="Email verification status"
			mix={css({
				...cardCss,
				borderColor: delivery.tone === 'error' ? colors.danger : colors.primary,
				backgroundColor:
					delivery.tone === 'error'
						? 'color-mix(in srgb, var(--color-danger) 6%, transparent)'
						: colors.primarySoftest,
			})}
		>
			<h2 mix={css(cardTitleCss)}>{promptTitle}</h2>
			{renderDeliveryIndicator(delivery.indicator)}
			<p mix={css(descriptionCss)}>{promptDescription}</p>
			{delivery.helpHref && delivery.helpLabel ? (
				<p mix={css({ ...descriptionCss, margin: 0 })}>
					<a href={delivery.helpHref} mix={css(mutedLinkCss)}>
						{delivery.helpLabel}
					</a>
				</p>
			) : null}
			{options.email ? (
				<p mix={css({ ...descriptionCss, margin: 0 })}>
					Sent to <strong>{options.email}</strong>
				</p>
			) : null}
			<div
				mix={css({
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
					alignItems: 'center',
				})}
			>
				<button
					type="button"
					disabled={!canResend || options.resendStatus === 'sending'}
					mix={[css(primaryButtonCss), on('click', options.onResend)]}
				>
					{options.resendStatus === 'sending'
						? 'Sending...'
						: canResend
							? 'Resend verification email'
							: 'Resend unavailable'}
				</button>
				{options.continueLabel && options.onContinue ? (
					<button
						type="button"
						mix={[css(secondaryButtonCss), on('click', options.onContinue)]}
					>
						{options.continueLabel}
					</button>
				) : null}
				{options.secondaryHref && options.secondaryLabel ? (
					<a href={options.secondaryHref} mix={css(mutedLinkCss)}>
						{options.secondaryLabel}
					</a>
				) : null}
			</div>
			{options.resendMessage ? (
				<p
					role="status"
					mix={css({
						color: options.resendTone === 'error' ? colors.error : colors.text,
						margin: 0,
					})}
				>
					{options.resendMessage}
				</p>
			) : null}
		</section>
	)
}

const deliverySpinnerCss = {
	display: 'inline-block',
	width: '1.1rem',
	height: '1.1rem',
	borderRadius: '999px',
	border: `2px solid color-mix(in srgb, ${colors.primary} 30%, transparent)`,
	borderTopColor: colors.primary,
	animation: 'kody-email-delivery-spin 0.8s linear infinite',
	'@keyframes kody-email-delivery-spin': {
		to: { transform: 'rotate(360deg)' },
	},
}
