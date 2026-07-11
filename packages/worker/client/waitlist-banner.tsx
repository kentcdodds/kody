import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	compactInputCss,
	getPrimaryButtonCss,
	layoutMaxWidths,
} from '#client/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'

type WaitlistStatus = 'idle' | 'submitting' | 'success' | 'error'

/**
 * Compact site-wide waitlist strip for signed-out visitors. Posts to the same
 * `/waiting-list` endpoint as the signup page.
 */
export function WaitlistBanner(handle: Handle) {
	let status: WaitlistStatus = 'idle'
	let message: string | null = null

	function setState(
		nextStatus: WaitlistStatus,
		nextMessage: string | null = null,
	) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const firstName = String(formData.get('firstName') ?? '').trim()
		const email = String(formData.get('email') ?? '').trim()

		if (!firstName || !email) {
			setState('error', 'First name and email are required.')
			return
		}

		setState('submitting')

		try {
			const response = await fetch('/waiting-list', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ firstName, email }),
			})
			const payload = await response.json().catch(() => null)

			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to join the waiting list.'
				setState('error', errorMessage)
				return
			}

			const successMessage =
				typeof payload?.message === 'string'
					? payload.message
					: "You're on the list. We'll be in touch."
			form.reset()
			setState('success', successMessage)
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		const isSubmitting = status === 'submitting'
		const isSuccess = status === 'success'

		return (
			<section aria-label="Join the waiting list" mix={css(bannerCss)}>
				<div mix={css(bannerInnerCss)}>
					{isSuccess ? (
						<p
							aria-live="polite"
							mix={css({
								margin: 0,
								color: colors.text,
								fontSize: typography.fontSize.sm,
								fontWeight: typography.fontWeight.medium,
							})}
						>
							{message}
						</p>
					) : (
						<>
							<p mix={css(promptCss)}>
								Kody is invite-only — join the waiting list
							</p>
							<form mix={[css(formCss), on('submit', handleSubmit)]}>
								<label mix={css(fieldCss)}>
									<span mix={css(visuallyHiddenCss)}>First name</span>
									<input
										type="text"
										name="firstName"
										required
										autoComplete="given-name"
										maxLength={80}
										placeholder="First name"
										mix={css(bannerInputCss)}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(visuallyHiddenCss)}>Email</span>
									<input
										type="email"
										name="email"
										required
										autoComplete="email"
										placeholder="Email"
										mix={css(bannerInputCss)}
									/>
								</label>
								<button
									type="submit"
									disabled={isSubmitting}
									mix={css(submitCss)}
								>
									{isSubmitting ? 'Joining…' : 'Join'}
								</button>
							</form>
							{message ? (
								<p
									aria-live="polite"
									mix={css({
										margin: 0,
										color: colors.error,
										fontSize: typography.fontSize.xs,
									})}
								>
									{message}
								</p>
							) : null}
						</>
					)}
				</div>
			</section>
		)
	}
}

const bannerCss = {
	width: '100%',
	margin: 0,
	padding: `${spacing.xs} ${spacing.xl}`,
	borderBottom: `1px solid ${colors.border}`,
	backgroundColor: colors.primarySoftest,
	boxSizing: 'border-box' as const,
	[mq.tablet]: {
		padding: `${spacing.xs} ${spacing.sm}`,
	},
	[mq.mobile]: {
		padding: `${spacing.xs} ${spacing.md}`,
	},
}

const bannerInnerCss = {
	maxWidth: layoutMaxWidths.wide,
	width: '100%',
	margin: '0 auto',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
	boxSizing: 'border-box' as const,
}

const promptCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal' as const,
		textAlign: 'center' as const,
		width: '100%',
	},
}

const formCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	flexWrap: 'wrap' as const,
	[mq.mobile]: {
		width: '100%',
	},
}

const fieldCss = {
	display: 'grid',
	margin: 0,
	flex: '1 1 8rem',
	minWidth: '7rem',
	[mq.mobile]: {
		flex: '1 1 calc(50% - 0.25rem)',
	},
}

const bannerInputCss = {
	...compactInputCss,
	backgroundColor: colors.surface,
	borderRadius: radius.sm,
}

const submitCss = {
	...getPrimaryButtonCss({ size: 'md' }),
	padding: `${spacing.xs} ${spacing.md}`,
	fontSize: typography.fontSize.sm,
	borderRadius: radius.sm,
	flex: '0 0 auto',
}

const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden' as const,
	clip: 'rect(0, 0, 0, 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
}
