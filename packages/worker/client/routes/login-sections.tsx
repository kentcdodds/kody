import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	fieldErrorProps,
	invalidFieldsForMessage,
} from '#client/form-error-fields.ts'
import { HeroStage } from '#client/hero-stage.tsx'
import { renderHoneypot } from '#client/honeypot-field.tsx'
import { turnstileWidgetClassName } from '#client/public-form-protection.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	authFieldCss,
	authFieldLabelCss,
	authFieldLabelRowCss,
	getAuthInputCss,
	getGhostButtonCss,
	getLanternGlowCss,
	getPillButtonCss,
	getSwapLabelCss,
	hoverMq,
	mergeCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { type AuthStatus } from './login-shared.ts'

const motionOk = '@media (prefers-reduced-motion: no-preference)'
const mobileMq = '@media (max-width: 900px)'

export function renderBrand(
	extraCss: Parameters<typeof css>[0],
	options: { decorative?: boolean } = {},
) {
	return (
		<a
			href="/"
			// Inside the aria-hidden visual panel the brand is decorative;
			// keeping it out of the tab order avoids focusing content that
			// assistive tech cannot see.
			tabIndex={options.decorative ? -1 : undefined}
			mix={css(extraCss)}
		>
			<img src="/images/kody-mark.png" alt="" width={34} height={34} />
			<span>Kody</span>
		</a>
	)
}

export function renderMobileBrand() {
	return renderBrand(authBrandMobileCss)
}

export function renderLoginVisualPanel() {
	return (
		<aside data-parallax-scope aria-hidden="true" mix={css(authVisualCss)}>
			{renderBrand(authBrandCss, { decorative: true })}
			<div mix={css(authSceneCss)}>
				<div mix={css(authStageWrapCss)}>
					<HeroStage size="auth" alt="" />
				</div>
				<p mix={css(authGreetingCss)}>Good to see you.</p>
				<p mix={css(authGreetingSubCss)}>
					Your packages, jobs, and memory: right where you left them.
				</p>
			</div>
			<p mix={css(authFactCss)}>
				Fully isolated per user. Your capabilities are yours alone.
			</p>
		</aside>
	)
}

// Only edits to text-like fields clear a submit error; toggling the
// Remember me checkbox does not change the credentials that failed.
function isTextEntryTarget(target: EventTarget | null) {
	if (target instanceof HTMLTextAreaElement) return true
	if (!(target instanceof HTMLInputElement)) return false
	return target.type !== 'checkbox' && target.type !== 'radio'
}

function renderStatusMessage(
	handleId: string,
	status: AuthStatus,
	message: string | null,
) {
	return (
		<>
			{/*
			 * A live region only announces text that changes while the
			 * region is already in the accessibility tree, so the announcer
			 * stays mounted for the life of the form. Errors use `alert`
			 * (assertive); everything else stays `status`. It is out of
			 * flow, so it costs no flex gap while empty.
			 */}
			<p
				id={`${handleId}-form-status`}
				role={status === 'error' ? 'alert' : 'status'}
				mix={css(visuallyHiddenCss)}
			>
				{message ?? ''}
			</p>
			{/*
			 * The visible copy is hidden from assistive tech so the same
			 * sentence is not announced twice, and stays conditional so an
			 * empty message adds no gap to the form.
			 */}
			<p
				aria-hidden="true"
				data-tone={status === 'error' ? 'error' : 'info'}
				hidden={message ? undefined : true}
				mix={css(formMessageCss)}
			>
				{message ?? ''}
			</p>
		</>
	)
}

export type LoginFormSharedProps = {
	handleId: string
	turnstileSiteKey: string | null
	status: AuthStatus
	message: string | null
	isSubmitting: boolean
	onFieldEdit: () => void
}

export function renderWaitingListForm(
	props: LoginFormSharedProps & { onSubmit: (event: SubmitEvent) => void },
) {
	const statusId = `${props.handleId}-form-status`
	const invalidFields = invalidFieldsForMessage(props.status, props.message, [
		'firstName',
		'email',
	])
	return (
		<form
			key="waiting-list"
			data-rise
			method="post"
			style={{ '--rise': '1' }}
			mix={[
				css(authFormCss),
				on('submit', props.onSubmit),
				on('input', (event) => {
					if (isTextEntryTarget(event.target)) props.onFieldEdit()
				}),
			]}
		>
			{renderHoneypot()}
			<div mix={css(authFieldCss)}>
				<label
					for={`${props.handleId}-first-name`}
					mix={css(authFieldLabelCss)}
				>
					First name
				</label>
				<input
					id={`${props.handleId}-first-name`}
					type="text"
					name="firstName"
					required
					autoFocus
					autoComplete="given-name"
					maxLength={80}
					placeholder="Ada"
					data-field-ring
					{...fieldErrorProps('firstName', invalidFields, statusId)}
					mix={css(authInputCss)}
				/>
			</div>
			<div mix={css(authFieldCss)}>
				<label
					for={`${props.handleId}-waitlist-email`}
					mix={css(authFieldLabelCss)}
				>
					Email
				</label>
				<input
					id={`${props.handleId}-waitlist-email`}
					type="email"
					name="email"
					required
					autoComplete="email"
					placeholder="you@yourdomain.dev"
					data-field-ring
					{...fieldErrorProps('email', invalidFields, statusId)}
					mix={css(authInputCss)}
				/>
			</div>
			{props.turnstileSiteKey ? (
				<div class={turnstileWidgetClassName}></div>
			) : null}
			{renderStatusMessage(props.handleId, props.status, props.message)}
			<button
				type={props.status === 'success' ? 'button' : 'submit'}
				aria-disabled={
					props.isSubmitting || props.status === 'success' ? 'true' : undefined
				}
				aria-busy={props.isSubmitting ? 'true' : undefined}
				mix={css(authSubmitCss)}
			>
				<span
					data-swap-label
					data-active={props.isSubmitting ? undefined : true}
					aria-hidden={props.isSubmitting ? 'true' : undefined}
				>
					Join the waiting list
				</span>
				<span
					data-swap-label
					data-active={props.isSubmitting ? true : undefined}
					aria-hidden={props.isSubmitting ? undefined : 'true'}
				>
					Joining…
				</span>
			</button>
		</form>
	)
}

export function renderAuthForm(
	props: LoginFormSharedProps & {
		isSignup: boolean
		showInviteSignup: boolean
		prefillInviteCode: string
		submitLabel: string
		submitBusyLabel: string
		onSubmit: (event: SubmitEvent) => void
		onPasskeySignIn: () => void
	},
) {
	const statusId = `${props.handleId}-form-status`
	const invalidFields = invalidFieldsForMessage(props.status, props.message, [
		'email',
		'password',
	])
	return (
		<form
			key="authentication"
			data-public-auth-form
			data-rise
			method="post"
			style={{ '--rise': '1' }}
			mix={[
				css(authFormCss),
				on('submit', props.onSubmit),
				on('input', (event) => {
					if (isTextEntryTarget(event.target)) props.onFieldEdit()
				}),
			]}
		>
			{renderHoneypot()}
			{props.isSignup ? (
				<div mix={css(authFieldCss)}>
					<label
						for={`${props.handleId}-username`}
						mix={css(authFieldLabelCss)}
					>
						Username
					</label>
					<input
						id={`${props.handleId}-username`}
						type="text"
						name="username"
						required
						autoFocus
						autoComplete="username"
						pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{1,30}[A-Za-z0-9]'}
						title="Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number."
						placeholder="kent"
						data-field-ring
						{...fieldErrorProps('username', invalidFields, statusId)}
						mix={css(authInputCss)}
					/>
				</div>
			) : null}
			<div mix={css(authFieldCss)}>
				<label for={`${props.handleId}-email`} mix={css(authFieldLabelCss)}>
					Email
				</label>
				<input
					id={`${props.handleId}-email`}
					type="email"
					name="email"
					required
					autoFocus={!props.isSignup}
					// Login uses username so vault entries that store the email
					// in the username field (1Password's default) can autofill.
					// Signup email stays email; the username field above is the
					// Kody handle.
					autoComplete={props.isSignup ? 'email' : 'username'}
					placeholder="you@yourdomain.dev"
					data-field-ring
					{...fieldErrorProps('email', invalidFields, statusId)}
					mix={css(authInputCss)}
				/>
			</div>
			<div mix={css(authFieldCss)}>
				{props.isSignup ? (
					<label
						for={`${props.handleId}-password`}
						mix={css(authFieldLabelCss)}
					>
						Password
					</label>
				) : (
					<div mix={css(authFieldLabelRowCss)}>
						<label
							for={`${props.handleId}-password`}
							mix={css(authFieldLabelCss)}
						>
							Password
						</label>
						<a href="/reset-password" mix={css(fieldAsideCss)}>
							Forgot password?
						</a>
					</div>
				)}
				<input
					id={`${props.handleId}-password`}
					type="password"
					name="password"
					required
					autoComplete={props.isSignup ? 'new-password' : 'current-password'}
					placeholder={props.isSignup ? 'At least 8 characters' : undefined}
					data-field-ring
					{...fieldErrorProps('password', invalidFields, statusId)}
					mix={css(authInputCss)}
				/>
			</div>
			{props.showInviteSignup ? (
				<div mix={css(authFieldCss)}>
					<label
						for={`${props.handleId}-invite-code`}
						mix={css(authFieldLabelCss)}
					>
						Invite code
					</label>
					<input
						id={`${props.handleId}-invite-code`}
						type="text"
						name="inviteCode"
						defaultValue={props.prefillInviteCode}
						autoComplete="one-time-code"
						placeholder="Enter your invite code"
						data-field-ring
						{...fieldErrorProps('inviteCode', invalidFields, statusId)}
						mix={css(authInputCss)}
					/>
				</div>
			) : null}
			{props.turnstileSiteKey ? (
				<div class={turnstileWidgetClassName}></div>
			) : null}
			{!props.isSignup ? (
				<label mix={css(rememberCss)}>
					<input
						type="checkbox"
						name="rememberMe"
						defaultChecked
						mix={css(rememberInputCss)}
					/>
					<span>Remember me on this device</span>
				</label>
			) : null}
			{renderStatusMessage(props.handleId, props.status, props.message)}
			<button
				type="submit"
				disabled={props.isSubmitting}
				mix={css(authSubmitCss)}
			>
				<span
					data-swap-label
					data-active={props.isSubmitting ? undefined : true}
					aria-hidden={props.isSubmitting ? 'true' : undefined}
				>
					{props.submitLabel}
				</span>
				<span
					data-swap-label
					data-active={props.isSubmitting ? true : undefined}
					aria-hidden={props.isSubmitting ? undefined : 'true'}
				>
					{props.submitBusyLabel}
				</span>
			</button>
			{props.isSignup ? (
				<p mix={css(signupConsentCss)}>
					By creating an account you agree to the{' '}
					<a href="/terms">Terms of Service</a> and acknowledge the{' '}
					<a href="/privacy">Privacy Policy</a>.
				</p>
			) : null}
			{!props.isSignup ? (
				<button
					type="button"
					disabled={props.isSubmitting}
					mix={[css(ghostButtonCss), on('click', props.onPasskeySignIn)]}
				>
					<svg
						viewBox="0 0 24 24"
						width="17"
						height="17"
						aria-hidden="true"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
						<circle cx="16.5" cy="7.5" r="0.5" fill="currentColor" />
					</svg>
					Sign in with a passkey
				</button>
			) : null}
		</form>
	)
}

/* Brand panel: same flat canvas, shirt fabric across the whole panel, the
   layered lantern stage doing the welcoming. */
const authVisualCss = {
	position: 'relative' as const,
	display: 'flex',
	flexDirection: 'column' as const,
	justifyContent: 'space-between',
	gap: '2rem',
	padding: 'clamp(1.5rem, 3vw, 2.5rem)',
	borderRight: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	overflow: 'hidden',
	// See `pageHeadCss`: `isolate` keeps the fabric behind the panel content
	// without dropping it behind this panel's own background.
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: 0,
		background: `radial-gradient(ellipse 70% 62% at 50% 52%, oklch(from ${colors.text} l c h / 0.06), transparent 78%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	[mobileMq]: {
		display: 'none',
	},
}

const brandBaseCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

const authBrandCss = {
	...brandBaseCss,
	position: 'relative' as const,
	alignSelf: 'flex-start',
}

/* The brand only shows inside the form panel once the visual panel is gone. */
const authBrandMobileCss = {
	...brandBaseCss,
	display: 'none',
	[mobileMq]: {
		display: 'inline-flex',
		marginInline: 'auto',
	},
}

const authSceneCss = {
	position: 'relative' as const,
	textAlign: 'center' as const,
	marginInline: 'auto',
	width: '100%',
}

/* The lantern casts its light here too. */
const authStageWrapCss = {
	position: 'relative' as const,
	width: 'min(100%, 440px)',
	marginInline: 'auto',
	/* On short viewports the stage shrinks before anything clips. */
	'@media (min-width: 901px) and (max-height: 820px)': {
		width: 'min(100%, 340px)',
	},
	...getLanternGlowCss({ maxWidth: '160px' }),
}

const authGreetingCss = {
	margin: '1.6rem auto 0',
	font: `800 clamp(1.7rem, 2.4vw, 2.1rem)/1.1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.02em',
	color: colors.text,
}

const authGreetingSubCss = {
	margin: '0.7rem auto 0',
	color: colors.textMuted,
	maxWidth: '34ch',
}

const authFactCss = {
	position: 'relative' as const,
	margin: 0,
	textAlign: 'center' as const,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

const authFormCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '1.1rem',
}

/* Fields sit on the lighter surface, so they take the canvas tone and read
   as wells in both themes. */
const authInputCss = getAuthInputCss({ background: 'canvas' })

const inlineLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': { color: colors.text },
}

const fieldAsideCss = {
	...inlineLinkCss,
	fontSize: '0.88rem',
}

const signupConsentCss = {
	margin: 0,
	fontSize: '0.85rem',
	lineHeight: 1.5,
	color: colors.textMuted,
	'& a': {
		color: colors.textMuted,
		textDecoration: 'underline',
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
}

const rememberCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	fontSize: '0.95rem',
	color: colors.text,
	cursor: 'pointer',
	alignSelf: 'flex-start',
}

const rememberInputCss = {
	width: '1.1em',
	height: '1.1em',
	margin: 0,
	accentColor: colors.primary,
	cursor: 'pointer',
}

/* Status/error line. The `success-in` keyframes live in public/styles.css
   inside the reduced-motion-gated block, so the entrance simply no-ops when
   motion is off. */
export const formMessageCss = {
	margin: 0,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	textAlign: 'left' as const,
	color: colors.textMuted,
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
	'&[data-tone="error"]': {
		color: colors.error,
	},
	[motionOk]: {
		'&:not([hidden])': {
			animation: `success-in 250ms ${transitions.easeOut} both`,
		},
	},
}

const authSubmitCss = mergeCss(getPillButtonCss(), getSwapLabelCss(), {
	marginTop: '0.3rem',
	'&:disabled, &[aria-disabled="true"]': {
		opacity: 0.7,
		cursor: 'progress',
		transform: 'none',
	},
	[hoverMq]: {
		'&[aria-disabled="true"]:hover, &[aria-disabled="true"]:active': {
			transform: 'none',
			boxShadow: 'none',
		},
	},
})

export const ghostButtonCss = getGhostButtonCss()
