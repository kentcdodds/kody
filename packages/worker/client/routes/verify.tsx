import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readRouterSearch } from '#client/router-location.tsx'
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
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

function normalizeRedirectTo(value: string | null) {
	if (!value) return null
	if (!value.startsWith('/')) return null
	if (value.startsWith('//')) return null
	return value
}

function buildLoginHref(redirectTo: string | null) {
	return redirectTo
		? `/login?redirectTo=${encodeURIComponent(redirectTo)}`
		: '/login'
}

export function VerifyRoute(handle: Handle) {
	let status: 'idle' | 'submitting' = 'idle'
	let message: string | null = null

	function getRedirectTo() {
		const params = new URLSearchParams(readRouterSearch(handle))
		return normalizeRedirectTo(params.get('redirectTo'))
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const code = String(formData.get('code') ?? '').trim()
		if (!code) {
			message = 'Enter the 6-digit code from your authenticator app.'
			handle.update()
			return
		}

		status = 'submitting'
		message = null
		handle.update()

		try {
			const response = await fetch('/verify/2fa.json', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ code }),
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok || !payload?.ok) {
				if (payload?.code === 'expired') {
					window.location.assign(buildLoginHref(getRedirectTo()))
					return
				}
				status = 'idle'
				message =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to verify the code.'
				handle.update()
				return
			}

			window.location.assign(getRedirectTo() ?? '/account')
		} catch {
			status = 'idle'
			message = 'Network error. Please try again.'
			handle.update()
		}
	}

	return () => {
		const isSubmitting = status === 'submitting'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h2 mix={css(pageTitleCss)}>Two-factor authentication</h2>
					<p mix={css(pageDescriptionCss)}>
						Enter the 6-digit code from your authenticator app to finish signing
						in.
					</p>
				</header>
				<form mix={[css(cardCss), on('submit', handleSubmit)]}>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Verification code</span>
						<input
							type="text"
							name="code"
							required
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]{6}"
							placeholder="123456"
							mix={css(inputCss)}
						/>
					</label>
					<button
						type="submit"
						disabled={isSubmitting}
						mix={css(primaryButtonCss)}
					>
						{isSubmitting ? 'Verifying...' : 'Verify'}
					</button>
					{message ? (
						<p
							aria-live="polite"
							mix={css({
								color: colors.error,
								fontSize: typography.fontSize.sm,
							})}
						>
							{message}
						</p>
					) : null}
				</form>
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<a href={buildLoginHref(getRedirectTo())} mix={css(mutedLinkCss)}>
						Back to login
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
