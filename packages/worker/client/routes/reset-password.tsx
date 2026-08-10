import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
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
} from '#universal/styles/style-primitives.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'

type ResetStatus = 'idle' | 'submitting' | 'success' | 'error'

function getSearchParams(handle: Handle) {
	return new URLSearchParams(readRouterSearch(handle))
}

export function ResetPasswordRoute(handle: Handle) {
	let status: ResetStatus = 'idle'
	let message: string | null = null
	let turnstileSiteKey: string | null | undefined

	function setState(
		nextStatus: ResetStatus,
		nextMessage: string | null = null,
	) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	async function loadProtectionConfig(signal: AbortSignal) {
		if (turnstileSiteKey !== undefined) return
		const config = await fetchPublicAuthConfig(signal)
		if (signal.aborted) return
		turnstileSiteKey = config?.turnstileSiteKey ?? null
		handle.update()
	}

	async function submitResetRequest(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData)
		if (!email) {
			setState('error', 'Email is required.')
			return
		}

		setState('submitting')
		try {
			const response = await fetch('/password-reset', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, ...protection }),
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
		const protection = readPublicFormProtection(formData)
		if (!password) {
			setState('error', 'Password is required.')
			return
		}

		setState('submitting')
		try {
			const response = await fetch('/password-reset/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, password, ...protection }),
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
			setState('success', 'Password updated. You can sign in.')
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		if (typeof document !== 'undefined' && turnstileSiteKey === undefined) {
			handle.queueTask(loadProtectionConfig)
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey ?? null))
		}
		const searchParams = getSearchParams(handle)
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
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>{title}</h1>
					<p mix={css(pageDescriptionCss)}>{description}</p>
				</header>
				<form
					{...passwordManagerIgnoreProps}
					mix={[
						css(cardCss),
						on(
							'submit',

							(event) =>
								mode === 'confirm'
									? submitResetConfirm(event, token)
									: submitResetRequest(event),
						),
					]}
				>
					<input
						type="text"
						name={honeypotFieldName}
						tabIndex={-1}
						autoComplete="off"
						aria-hidden="true"
						mix={css(honeypotCss)}
					/>
					{mode === 'confirm' ? (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>New password</span>
							<input
								type="password"
								name="password"
								required
								{...passwordManagerIgnoreProps}
								placeholder="At least 8 characters"
								disabled={isSubmitting}
								mix={css(inputCss)}
							/>
						</label>
					) : (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Email</span>
							<input
								type="email"
								name="email"
								required
								autoComplete="email"
								placeholder="you@example.com"
								disabled={isSubmitting}
								mix={css(inputCss)}
							/>
						</label>
					)}
					{turnstileSiteKey ? (
						<div class={turnstileWidgetClassName}></div>
					) : null}
					<button
						type="submit"
						disabled={isSubmitting}
						mix={css(primaryButtonCss)}
					>
						{isSubmitting
							? 'Submitting...'
							: mode === 'confirm'
								? 'Update password'
								: 'Send reset link'}
					</button>
					{message ? (
						<p
							aria-live="polite"
							mix={css({
								color: status === 'error' ? colors.error : colors.text,
								fontSize: typography.fontSize.sm,
							})}
						>
							{message}
						</p>
					) : null}
				</form>
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<a href="/login" mix={css(primaryLinkCss)}>
						Back to sign in
					</a>
					<a href="/" mix={css(mutedLinkCss)}>
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

const honeypotCss = {
	position: 'absolute' as const,
	left: '-10000px',
	width: '1px',
	height: '1px',
	overflow: 'hidden' as const,
}
