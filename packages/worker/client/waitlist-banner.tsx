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
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'

type WaitlistStatus = 'idle' | 'submitting' | 'success' | 'error'

/**
 * Compact site-wide waitlist strip for signed-out visitors. Posts to the same
 * `/waiting-list` endpoint as the signup page.
 */
export function WaitlistBanner(handle: Handle) {
	let status: WaitlistStatus = 'idle'
	let message: string | null = null
	let turnstileSiteKey: string | null | undefined

	function setState(
		nextStatus: WaitlistStatus,
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

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const firstName = String(formData.get('firstName') ?? '').trim()
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData)

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
				body: JSON.stringify({ firstName, email, ...protection }),
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
		if (typeof document !== 'undefined' && turnstileSiteKey === undefined) {
			handle.queueTask(loadProtectionConfig)
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey ?? null))
		}
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
								Built for people who want to own their automations. Join the
								waitlist for an invite.
							</p>
							<form mix={[css(formCss), on('submit', handleSubmit)]}>
								<input
									type="text"
									name={honeypotFieldName}
									tabIndex={-1}
									autoComplete="off"
									aria-hidden="true"
									mix={css(honeypotCss)}
								/>
								<label mix={css(nameFieldCss)}>
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
								<div mix={css(emailGroupCss)}>
									<label mix={css(emailFieldCss)}>
										<span mix={css(visuallyHiddenCss)}>Email</span>
										<input
											type="email"
											name="email"
											required
											autoComplete="email"
											placeholder="Email"
											mix={css(emailInputCss)}
										/>
									</label>
									<button
										type="submit"
										disabled={isSubmitting}
										mix={css(submitCss)}
									>
										{isSubmitting ? 'Joining…' : 'Join'}
									</button>
								</div>
								{turnstileSiteKey ? (
									<div class={turnstileWidgetClassName}></div>
								) : null}
							</form>
							<p
								aria-live="polite"
								role={status === 'error' ? 'alert' : undefined}
								mix={css({
									margin: 0,
									color: colors.error,
									fontSize: typography.fontSize.xs,
									width: '100%',
									textAlign: 'center' as const,
								})}
							>
								{message ?? ''}
							</p>
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
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal' as const,
		textAlign: 'center' as const,
		width: '100%',
	},
}

const formCss = {
	display: 'flex',
	alignItems: 'stretch',
	gap: spacing.xs,
	flexWrap: 'wrap' as const,
	marginBottom: 0,
	[mq.mobile]: {
		width: '100%',
	},
}

const nameFieldCss = {
	display: 'grid',
	margin: 0,
	flex: '0 1 9rem',
	minWidth: '7rem',
	[mq.mobile]: {
		flex: '1 1 6rem',
		minWidth: '5.5rem',
	},
}

const emailGroupCss = {
	display: 'flex',
	alignItems: 'stretch',
	flex: '1 1 14rem',
	minWidth: '12rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	overflow: 'hidden',
	backgroundColor: colors.surface,
	'&:focus-within': {
		borderColor: colors.primary,
	},
	[mq.mobile]: {
		flex: '1 1 11rem',
		minWidth: '10rem',
	},
}

const emailFieldCss = {
	display: 'grid',
	margin: 0,
	flex: '1 1 auto',
	minWidth: 0,
}

const bannerInputCss = {
	...compactInputCss,
	height: '100%',
	backgroundColor: colors.surface,
	borderRadius: radius.sm,
}

const emailInputCss = {
	...bannerInputCss,
	border: 'none',
	borderRadius: 0,
	boxShadow: 'none',
	outline: 'none',
	'&:focus': {
		outline: 'none',
		boxShadow: 'none',
		borderColor: 'transparent',
	},
}

const submitCss = {
	...getPrimaryButtonCss({ size: 'md' }),
	padding: `${spacing.xs} ${spacing.md}`,
	fontSize: typography.fontSize.sm,
	borderRadius: 0,
	flex: '0 0 auto',
	alignSelf: 'stretch',
	transform: 'none',
	'&:not(:disabled):hover': {
		backgroundColor: colors.primaryHover,
		transform: 'none',
	},
	'&:not(:disabled):active': {
		backgroundColor: colors.primaryActive,
		transform: 'none',
	},
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

const honeypotCss = {
	...visuallyHiddenCss,
	left: '-10000px',
}
