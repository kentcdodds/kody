import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	getPillButtonCss,
	layoutMaxWidths,
	pageGutter,
} from '#client/styles/style-primitives.ts'
import { colors, transitions, typography } from '#client/styles/tokens.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
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
				// Turnstile tokens are single-use and the form stays mounted
				// for another try, so it needs a fresh one.
				resetTurnstileWidgets()
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
			resetTurnstileWidgets()
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
						<p aria-live="polite" mix={css(successCss)}>
							{message}
						</p>
					) : (
						<>
							<p mix={css(promptCss)}>
								<span data-lede>
									Built for people who want to own their automations.
								</span>{' '}
								Join the waitlist for an invite.
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
								{/*
								 * One connected pill, same grammar as the hero waitlist and
								 * the community search. `data-focus-container` opts into the
								 * shared rules in styles.css: the container shows a single
								 * ring for the whole control and the submit draws its own
								 * inside itself.
								 */}
								<div data-focus-container mix={css(pillCss)}>
									<label
										for={`${handle.id}-waitlist-name`}
										mix={css(visuallyHiddenCss)}
									>
										First name
									</label>
									<input
										id={`${handle.id}-waitlist-name`}
										type="text"
										name="firstName"
										required
										autoComplete="given-name"
										maxLength={80}
										placeholder="First name"
										mix={css(pillNameInputCss)}
									/>
									<label
										for={`${handle.id}-waitlist-email`}
										mix={css(visuallyHiddenCss)}
									>
										Email
									</label>
									<input
										id={`${handle.id}-waitlist-email`}
										type="email"
										name="email"
										required
										autoComplete="email"
										placeholder="Email"
										mix={css(pillEmailInputCss)}
									/>
									<button
										type="submit"
										disabled={isSubmitting}
										mix={css(pillSubmitCss)}
									>
										{isSubmitting ? 'Joining…' : 'Join'}
									</button>
								</div>
								{turnstileSiteKey ? (
									<div class={turnstileWidgetClassName}></div>
								) : null}
							</form>
							{/*
							 * Announcer stays mounted so a live region has something to
							 * change, but it is out of flow — rendered conditionally it used
							 * to reserve an empty line and add roughly 20px to a strip whose
							 * whole point is being shallow.
							 */}
							<p
								aria-live="polite"
								role={status === 'error' ? 'alert' : undefined}
								mix={css(visuallyHiddenCss)}
							>
								{message ?? ''}
							</p>
							{message ? (
								<p aria-hidden="true" mix={css(errorCss)}>
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

/* Pill geometry, shared so a segment's corners nest inside the container's. */
const pillRadius = '999px'
const pillStackRadius = '20px'
const pillPadding = '0.25rem'

/* Stacks below this: three segments cannot hold their placeholders on a phone
   without truncating them to nonsense. */
const stackMq = '@media (max-width: 720px)'

const bannerCss = {
	width: '100%',
	margin: 0,
	/* Deliberately shallow — this sits above the header on secondary pages and
	   should read as a quiet strip, not a second hero. */
	padding: `0.55rem ${pageGutter}`,
	borderBottom: `1px solid ${colors.border}`,
	/* A whisper of the accent so the strip separates from the header without
	   competing with it. */
	backgroundColor: colors.primarySoftest,
	boxSizing: 'border-box' as const,
	[stackMq]: {
		padding: `0.7rem ${pageGutter}`,
	},
}

const bannerInnerCss = {
	maxWidth: layoutMaxWidths.wide,
	width: '100%',
	margin: '0 auto',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '1rem',
	flexWrap: 'wrap' as const,
	boxSizing: 'border-box' as const,
	[stackMq]: {
		gap: '0.55rem',
	},
}

const promptCss = {
	margin: 0,
	color: colors.text,
	fontSize: '0.92rem',
	fontWeight: 550,
	/* The positioning line is context; the sentence after it is the ask. */
	'& > [data-lede]': { color: colors.textMuted },
	[stackMq]: {
		textAlign: 'center' as const,
		width: '100%',
		fontSize: '0.88rem',
		/* Only the ask survives on a phone. Keeping the positioning line instead
		   cost two wrapped lines on a strip that should be one. */
		'& > [data-lede]': { display: 'none' },
	},
}

const formCss = {
	display: 'flex',
	alignItems: 'stretch',
	margin: 0,
	minWidth: 0,
	[stackMq]: {
		width: '100%',
	},
}

const pillCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 8.5rem) minmax(0, 12rem) auto',
	alignItems: 'stretch',
	width: '100%',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: pillRadius,
	padding: pillPadding,
	boxSizing: 'border-box' as const,
	transition: `border-color 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
	'&:focus-within': {
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
	[stackMq]: {
		/* Two fields across, the button spanning beneath them: keeps the strip to
		   two rows instead of three while every placeholder stays readable. */
		gridTemplateColumns: '1fr 1fr',
		borderRadius: pillStackRadius,
		gap: pillPadding,
	},
}

const pillInputBaseCss = {
	font: `400 0.92rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: 'transparent',
	border: 'none',
	padding: '0.4rem 0.9rem',
	minWidth: 0,
	'&::placeholder': { color: colors.textMuted, opacity: 1 },
	/* No tint on focus: the container ring plus the caret already say where
	   focus is, and a filled segment reads as a slab inside the pill. */
	'&:focus': { outline: 'none' },
}

const pillNameInputCss = {
	...pillInputBaseCss,
	/* Leading segment: the container's inner curve outside, square where it
	   meets the next segment. */
	borderRadius: `calc(${pillRadius} - ${pillPadding}) 0 0 calc(${pillRadius} - ${pillPadding})`,
	[stackMq]: {
		borderRadius: `calc(${pillStackRadius} - ${pillPadding}) 0 0 0`,
	},
}

const pillEmailInputCss = {
	...pillInputBaseCss,
	borderLeft: `1px solid ${colors.border}`,
	borderRadius: 0,
	[stackMq]: {
		borderRadius: `0 calc(${pillStackRadius} - ${pillPadding}) 0 0`,
	},
}

const successCss = {
	margin: 0,
	color: colors.text,
	fontSize: '0.92rem',
	fontWeight: 550,
	textAlign: 'center' as const,
}

const errorCss = {
	margin: 0,
	color: colors.error,
	fontSize: '0.82rem',
	width: '100%',
	textAlign: 'center' as const,
}

const pillSubmitCss = {
	...getPillButtonCss(),
	fontSize: '0.9rem',
	padding: '0.4rem 1.15rem',
	whiteSpace: 'nowrap' as const,
	[stackMq]: {
		gridColumn: '1 / -1',
		justifyContent: 'center',
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
