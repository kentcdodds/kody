import { type Handle } from 'remix/component'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	primaryLinkCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

type ResetStatus = 'idle' | 'submitting' | 'success' | 'error'

function getSearchParams() {
	return typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search)
}

export function ResetPasswordRoute(handle: Handle) {
	let status: ResetStatus = 'idle'
	let message: string | null = null

	function setState(
		nextStatus: ResetStatus,
		nextMessage: string | null = null,
	) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	async function submitResetRequest(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const email = String(formData.get('email') ?? '').trim()
		if (!email) {
			setState('error', 'Email is required.')
			return
		}

		setState('submitting')
		try {
			const response = await fetch('/password-reset', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email }),
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to request a reset.'
				setState('error', errorMessage)
				return
			}
			setState(
				'success',
				payload?.message ?? 'Check your inbox for a reset link.',
			)
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	async function submitResetConfirm(event: SubmitEvent, token: string) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const password = String(formData.get('password') ?? '')
		if (!password) {
			setState('error', 'Password is required.')
			return
		}

		setState('submitting')
		try {
			const response = await fetch('/password-reset/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, password }),
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to reset password.'
				setState('error', errorMessage)
				return
			}
			setState('success', 'Password updated. You can sign in now.')
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		const searchParams = getSearchParams()
		const token = String(searchParams.get('token') ?? '').trim()
		const mode = token ? 'confirm' : 'request'
		const isSubmitting = status === 'submitting'
		const title =
			mode === 'confirm' ? 'Choose a new password' : 'Reset your password'
		const description =
			mode === 'confirm'
				? 'Enter a new password for your account.'
				: 'We will send a reset link to your email.'

		return (
			<section css={pageCss}>
				<header css={pageHeaderCss}>
					<h2 css={pageTitleCss}>{title}</h2>
					<p css={pageDescriptionCss}>{description}</p>
				</header>
				<form
					css={cardCss}
					on={{
						submit: (event) =>
							mode === 'confirm'
								? submitResetConfirm(event, token)
								: submitResetRequest(event),
					}}
				>
					{mode === 'confirm' ? (
						<label css={fieldCss}>
							<span css={fieldLabelCss}>New password</span>
							<input
								type="password"
								name="password"
								required
								autoComplete="new-password"
								placeholder="At least 8 characters"
								disabled={isSubmitting}
								css={inputCss}
							/>
						</label>
					) : (
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Email</span>
							<input
								type="email"
								name="email"
								required
								autoComplete="email"
								placeholder="you@example.com"
								disabled={isSubmitting}
								css={inputCss}
							/>
						</label>
					)}
					<button type="submit" disabled={isSubmitting} css={primaryButtonCss}>
						{isSubmitting
							? 'Submitting...'
							: mode === 'confirm'
								? 'Update password'
								: 'Send reset link'}
					</button>
					{message ? (
						<p
							css={{
								color: status === 'error' ? colors.error : colors.text,
								fontSize: typography.fontSize.sm,
							}}
							aria-live="polite"
						>
							{message}
						</p>
					) : null}
				</form>
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<a href="/login" css={primaryLinkCss}>
						Back to sign in
					</a>
					<a href="/" css={mutedLinkCss}>
						Back home
					</a>
				</div>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
