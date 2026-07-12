import { css } from 'remix/ui'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { on } from '#client/event-mixin.ts'
import { colors, spacing } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
} from '#client/styles/style-primitives.ts'

export {
	buildPendingVerificationPath,
	pendingVerificationPath,
} from '#client/routes/pending-verification-path.ts'

export const resendVerificationApiPath = '/account/resend-verification.json'

export type ResendVerificationResult =
	| { ok: true; message: string }
	| { ok: false; message: string; unauthorized?: boolean }

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

type EmailVerificationPromptOptions = {
	email?: string | null
	title?: string
	description: string
	resendStatus: 'idle' | 'sending'
	resendMessage: string | null
	resendTone?: 'error' | 'info'
	onResend: () => void
	continueLabel?: string | null
	onContinue?: (() => void) | null
	secondaryHref?: string | null
	secondaryLabel?: string | null
}

/**
 * Shared verify-email callout used by pending signup, account, and the MCP
 * authorize gate. Keeps resend/continue actions consistent.
 */
export function renderEmailVerificationPrompt(
	options: EmailVerificationPromptOptions,
) {
	const title = options.title ?? 'Verify your email'
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
				borderColor: colors.primary,
				backgroundColor: colors.primarySoftest,
			})}
		>
			<h2 mix={css(cardTitleCss)}>{title}</h2>
			<p mix={css(descriptionCss)}>{options.description}</p>
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
					disabled={options.resendStatus === 'sending'}
					mix={[css(primaryButtonCss), on('click', options.onResend)]}
				>
					{options.resendStatus === 'sending'
						? 'Sending...'
						: 'Resend verification email'}
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
