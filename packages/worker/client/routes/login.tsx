import { startAuthentication } from '@simplewebauthn/browser'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	getPathname,
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { readRouterSearch } from '#client/router-location.tsx'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import { fetchSessionInfo, type SessionStatus } from '#client/session.ts'
import {
	fetchPublicAuthConfig,
	startSocialSignIn,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'
import {
	clearStoredFirstTouchAttribution,
	readSignupFirstTouchAttribution,
} from '#client/first-touch-attribution.ts'
import { fathomEventNames, trackFathomEvent } from '#client/fathom-events.ts'
import { serializeFirstTouchAttributionForTransport } from '#universal/first-touch-attribution.ts'
import { withAccountCreatedQuery } from '#universal/fathom-events.ts'
import {
	emptyPublicFormProtection,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
} from '#client/public-form-protection.ts'
import { type SignupMode } from '#universal/signup-mode.ts'
import { colors } from '#universal/styles/tokens.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import {
	type AuthStatus,
	type SignupPanel,
	buildAuthPath,
	buildInviteSignupPath,
	getAuthModeFromPathname,
	getCurrentAuthMode,
	getCurrentRedirectTo,
	getSearchParams,
	resolveSignupPanel,
	readPrefillInviteCode,
} from './login-shared.ts'
import {
	formMessageCss,
	ghostButtonCss,
	renderAuthForm,
	renderLoginVisualPanel,
	renderMobileBrand,
	renderWaitingListForm,
} from './login-sections.tsx'

/**
 * heykody.dev login/signup, ported from the redesign prototype
 * (`landing/login.html`): a standalone two-panel canvas. The brand panel
 * (hidden below 900px) carries the lantern stage over the shirt-pattern
 * whisper; the form panel holds the auth card, which rises in the page-open
 * choreography (head → form → divider → oauth → foot). The app shell hides
 * the site header/footer here (`isAuthShellPath` in `app.tsx`).
 */
export function LoginRoute(handle: Handle) {
	let status: AuthStatus = 'idle'
	let message: string | null = null
	let sessionStatus: SessionStatus = 'idle'
	let sessionEmail = ''
	let authProviders: Array<AuthProviderInfo> = []
	let signupMode: SignupMode = 'invite'
	let turnstileSiteKey: string | null = null
	// True once the provider list came from SSR-embedded or SPA-preloaded
	// loader data (the normal paths); the client fetch is a fallback only.
	let authProvidersReady = false
	let activeMode = getCurrentAuthMode(handle)
	let routePath: string | null = null
	let activeSignupSearch = readRouterSearch(handle)
	let signupPanel: SignupPanel = resolveSignupPanel(
		getSearchParams(handle),
		signupMode,
	)
	let prefillInviteCode = readPrefillInviteCode(getSearchParams(handle))
	let signupStartedTracked = false

	function maybeTrackSignupStarted() {
		if (signupStartedTracked) return
		if (getCurrentAuthMode(handle) !== 'signup') return
		readSignupFirstTouchAttribution()
		if (!trackFathomEvent(fathomEventNames.signupStarted)) return
		signupStartedTracked = true
	}

	function setState(nextStatus: AuthStatus, nextMessage: string | null = null) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	/**
	 * Report a failure that came back from the server. The challenge token the
	 * request carried is spent (Turnstile tokens are single-use), and the form
	 * stays mounted for another try, so it needs a fresh one. Plain `setState`
	 * still covers client-side validation, where nothing was sent and the
	 * token the user already solved is still good.
	 */
	function setSubmitError(nextMessage: string) {
		resetTurnstileWidgets()
		setState('error', nextMessage)
	}

	function resetAuthState() {
		status = 'idle'
		message = null
	}

	function clearFieldError() {
		if (status !== 'error') return
		resetAuthState()
		handle.update()
	}

	function applySignupSearch(searchParams: URLSearchParams) {
		signupPanel = resolveSignupPanel(searchParams, signupMode)
		prefillInviteCode = readPrefillInviteCode(searchParams)
	}

	function setSignupPanel(nextPanel: SignupPanel) {
		signupPanel = nextPanel
		resetAuthState()
		handle.update()
	}

	listenToRouterNavigation(handle, () => {
		if (!routePath) return
		const nextPath = getPathname(handle)
		if (nextPath === routePath) return
		routePath = nextPath
		resetAuthState()
		if (getAuthModeFromPathname(nextPath) === 'signup') {
			signupStartedTracked = false
			applySignupSearch(getSearchParams(handle))
		}
	})

	async function loadSessionAndProviders(signal: AbortSignal) {
		if (sessionStatus !== 'idle') return
		sessionStatus = 'loading'

		const [session, config] = await Promise.all([
			fetchSessionInfo(signal),
			authProvidersReady ? null : fetchPublicAuthConfig(signal),
		])
		if (signal.aborted) {
			// Hydration re-renders abort in-flight queued tasks; reset so the
			// next render re-queues the load instead of stalling on 'loading'.
			sessionStatus = 'idle'
			return
		}
		sessionEmail = session?.email ?? ''
		if (config && !authProvidersReady) {
			authProviders = config.providers
			signupMode = config.signupMode
			turnstileSiteKey = config.turnstileSiteKey
			applySignupSearch(getSearchParams(handle))
			authProvidersReady = true
		}

		sessionStatus = 'ready'
		if (sessionEmail) {
			window.location.assign(getCurrentRedirectTo(handle) ?? '/account')
			return
		}
		handle.update()
	}

	async function handleWaitingListSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (status === 'submitting' || status === 'success') return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const firstName = String(formData.get('firstName') ?? '').trim()
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData, form)

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
				setSubmitError(errorMessage)
				return
			}

			const successMessage =
				typeof payload?.message === 'string'
					? payload.message
					: "You're on the list. We'll be in touch."
			form.reset()
			setState('success', successMessage)
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const email = String(formData.get('email') ?? '').trim()
		const password = String(formData.get('password') ?? '')
		const mode = getCurrentAuthMode(handle)
		const username =
			mode === 'signup' ? String(formData.get('username') ?? '').trim() : ''
		const inviteCode =
			mode === 'signup' ? String(formData.get('inviteCode') ?? '').trim() : ''
		const rememberMe = mode === 'login' && formData.get('rememberMe') === 'on'
		const protection = readPublicFormProtection(formData, form)

		if (!email || !password) {
			setState('error', 'Email and password are required.')
			return
		}
		if (mode === 'signup' && !username) {
			setState('error', 'Username is required.')
			return
		}

		setState('submitting')

		try {
			const attribution =
				mode === 'signup' ? readSignupFirstTouchAttribution() : null
			const response = await fetch('/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					email,
					password,
					mode,
					rememberMe,
					...protection,
					...(mode === 'signup'
						? {
								username,
								inviteCode,
								redirectTo: getCurrentRedirectTo(handle),
								...serializeFirstTouchAttributionForTransport(attribution),
							}
						: {}),
				}),
			})
			const payload = await response.json().catch(() => null)

			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to authenticate.'
				setSubmitError(errorMessage)
				return
			}

			if (mode === 'signup') {
				const tracked = trackFathomEvent(fathomEventNames.accountCreated)
				clearStoredFirstTouchAttribution()
				if (typeof window !== 'undefined') {
					const destination = resolvePasswordAuthRedirect({
						mode,
						requiresTwoFactor: payload?.requiresTwoFactor === true,
						emailVerificationRequired:
							payload?.emailVerificationRequired === true,
						redirectTo: getCurrentRedirectTo(handle),
					})
					window.location.assign(
						tracked ? destination : withAccountCreatedQuery(destination),
					)
				}
				return
			}

			if (typeof window !== 'undefined') {
				window.location.assign(
					resolvePasswordAuthRedirect({
						mode,
						requiresTwoFactor: payload?.requiresTwoFactor === true,
						emailVerificationRequired:
							payload?.emailVerificationRequired === true,
						redirectTo: getCurrentRedirectTo(handle),
					}),
				)
			}
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	async function handleProviderSignIn(providerId: string) {
		setState('submitting')
		try {
			// Carry the invite code from the invite signup panel so production
			// social signup can consume it on the OAuth callback.
			let inviteCode: string | null = null
			if (getCurrentAuthMode(handle) === 'signup') {
				const inviteInput = document.querySelector('input[name="inviteCode"]')
				if (inviteInput instanceof HTMLInputElement) {
					inviteCode = inviteInput.value.trim() || null
				}
			}
			const authForm = document.querySelector<HTMLFormElement>(
				'form[data-public-auth-form]',
			)
			const protection = authForm
				? readPublicFormProtection(new FormData(authForm), authForm)
				: emptyPublicFormProtection()
			const errorMessage = await startSocialSignIn(
				providerId,
				getCurrentRedirectTo(handle),
				inviteCode,
				protection,
				getCurrentAuthMode(handle) === 'signup'
					? readSignupFirstTouchAttribution()
					: null,
			)
			if (errorMessage) {
				setSubmitError(errorMessage)
			}
			// On success the browser is navigating to the provider; leave the
			// submitting state in place.
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	async function handlePasskeySignIn() {
		setState('submitting')

		try {
			const optionsResponse = await fetch('/webauthn/authentication', {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			const optionsPayload = await optionsResponse.json().catch(() => null)
			if (
				!optionsResponse.ok ||
				optionsPayload?.ok !== true ||
				!optionsPayload.options
			) {
				setState('error', 'Unable to start passkey sign-in.')
				return
			}

			let authenticationResponse
			try {
				authenticationResponse = await startAuthentication({
					optionsJSON: optionsPayload.options,
				})
			} catch {
				setState('idle')
				return
			}

			const rememberMeInput = document.querySelector('input[name="rememberMe"]')
			const rememberMe =
				rememberMeInput instanceof HTMLInputElement && rememberMeInput.checked
			const authForm = document.querySelector<HTMLFormElement>(
				'form[data-public-auth-form]',
			)
			const protection = authForm
				? readPublicFormProtection(new FormData(authForm), authForm)
				: emptyPublicFormProtection()

			const verificationResponse = await fetch('/webauthn/authentication', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					response: authenticationResponse,
					rememberMe,
					...protection,
				}),
			})
			const verificationPayload = await verificationResponse
				.json()
				.catch(() => null)
			if (!verificationResponse.ok || verificationPayload?.ok !== true) {
				const errorMessage =
					typeof verificationPayload?.error === 'string'
						? verificationPayload.error
						: 'Passkey sign-in failed.'
				setSubmitError(errorMessage)
				return
			}

			window.location.assign(
				resolvePasswordAuthRedirect({
					mode: 'login',
					requiresTwoFactor: verificationPayload.requiresTwoFactor === true,
					redirectTo: getCurrentRedirectTo(handle),
				}),
			)
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	return () => {
		// Loader-data consumption runs during SSR as well, so the provider
		// buttons are in the server-rendered HTML rather than popping in.
		if (!authProvidersReady) {
			const routeData = tryConsumeRouteLoaderData(
				handle,
				'authProviders',
				readCurrentRouterHref(handle),
			)
			if (routeData) {
				authProviders = routeData.providers
				signupMode = routeData.signupMode
				turnstileSiteKey = routeData.turnstileSiteKey
				applySignupSearch(getSearchParams(handle))
				authProvidersReady = true
			}
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey))
		}
		if (typeof document !== 'undefined' && sessionStatus === 'idle') {
			handle.queueTask(loadSessionAndProviders)
		}
		if (typeof document !== 'undefined') {
			maybeTrackSignupStarted()
		}
		const mode = getCurrentAuthMode(handle)
		const currentSignupSearch = readRouterSearch(handle)
		if (!routePath) {
			routePath = getPathname(handle)
		}
		if (mode !== activeMode) {
			activeMode = mode
			resetAuthState()
			activeSignupSearch = currentSignupSearch
			applySignupSearch(getSearchParams(handle))
		} else if (
			mode === 'signup' &&
			currentSignupSearch !== activeSignupSearch
		) {
			activeSignupSearch = currentSignupSearch
			applySignupSearch(getSearchParams(handle))
			resetAuthState()
		}
		const redirectTo = getCurrentRedirectTo(handle)
		const oauthErrorMessage =
			!message && status === 'idle'
				? getOauthLoginErrorMessage(getSearchParams(handle).get('oauthError'))
				: null
		const isSignup = mode === 'signup'
		const showWaitingList = isSignup && signupPanel === 'waiting-list'
		const showInviteSignup = isSignup && signupPanel === 'invite'
		const isSubmitting = status === 'submitting'
		const title = showWaitingList
			? 'Join the waiting list'
			: isSignup
				? 'Create your account'
				: 'Welcome back'
		const description = showWaitingList
			? 'Kody is built for people who want to own their automations. Join the waitlist for an invite.'
			: isSignup
				? showInviteSignup
					? 'Use your invite code to create an account and start building automations you own.'
					: 'Create an account and start building automations you own.'
				: 'Sign in to pick up where you left off.'
		const submitLabel = isSignup ? 'Create account' : 'Sign in'
		const submitBusyLabel = isSignup ? 'Creating account…' : 'Signing in…'
		const showSocial = !showWaitingList && authProviders.length > 0

		return (
			<div mix={css(authLayoutCss)}>
				{renderLoginVisualPanel()}

				<div mix={css(authPanelCss)}>
					{renderMobileBrand()}

					<div mix={css(authCardCss)}>
						<header data-rise style={{ '--rise': '0' }} mix={css(authHeadCss)}>
							<h1>{title}</h1>
							<p>{description}</p>
						</header>

						{oauthErrorMessage ? (
							<p aria-live="polite" data-tone="error" mix={css(formMessageCss)}>
								{oauthErrorMessage}
							</p>
						) : null}

						{showWaitingList
							? renderWaitingListForm({
									handleId: handle.id,
									turnstileSiteKey,
									status,
									message,
									isSubmitting,
									onSubmit: handleWaitingListSubmit,
									onFieldEdit: clearFieldError,
								})
							: renderAuthForm({
									handleId: handle.id,
									turnstileSiteKey,
									status,
									message,
									isSubmitting,
									isSignup,
									showInviteSignup,
									prefillInviteCode,
									submitLabel,
									submitBusyLabel,
									onSubmit: handleSubmit,
									onPasskeySignIn: handlePasskeySignIn,
									onFieldEdit: clearFieldError,
								})}

						{isSignup ? (
							<button
								type="button"
								disabled={isSubmitting}
								data-rise
								style={{ '--rise': '2' }}
								mix={[
									css(ghostButtonCss),
									on('click', () =>
										setSignupPanel(showWaitingList ? 'invite' : 'waiting-list'),
									),
								]}
							>
								{showWaitingList
									? 'I have a code'
									: 'Join the waiting list instead'}
							</button>
						) : null}

						{showSocial ? (
							<>
								<div
									data-rise
									style={{ '--rise': '2' }}
									role="separator"
									aria-label="or continue with"
									mix={css(authDividerCss)}
								>
									<span>or continue with</span>
								</div>
								<div
									data-rise
									style={{ '--rise': '3' }}
									mix={css(authOauthCss)}
								>
									{authProviders.map((provider) => (
										<button
											key={provider.id}
											type="button"
											disabled={isSubmitting}
											aria-label={`Continue with ${provider.label}`}
											mix={[
												css(oauthButtonCss),
												on('click', () => handleProviderSignIn(provider.id)),
											]}
										>
											<ProviderIcon providerId={provider.id} size="1.4rem" />
										</button>
									))}
								</div>
							</>
						) : null}

						<footer data-rise style={{ '--rise': '4' }} mix={css(authFootCss)}>
							{isSignup ? (
								<p>
									Already have an account?{' '}
									<a href={buildAuthPath('login', redirectTo)}>Sign in</a>.
								</p>
							) : signupMode === 'open' ? (
								<p>
									New here?{' '}
									<a href={buildAuthPath('signup', redirectTo)}>
										Create an account
									</a>
									.
								</p>
							) : (
								<p>
									New here? Kody is invite-only:{' '}
									<a href="/#invite">join the waiting list</a> or{' '}
									<a href={buildInviteSignupPath(redirectTo)}>redeem a code</a>.
								</p>
							)}
							<p mix={css(authLegalCss)}>
								<a href="/privacy">Privacy</a>
								<a href="/terms">Terms</a>
							</p>
						</footer>
					</div>

					<div mix={css(authCornerCss)}>
						<a href="/">&larr; Back to Kody</a>
					</div>
				</div>
			</div>
		)
	}
}

const mobileMq = '@media (max-width: 900px)'

const authLayoutCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
	width: '100%',
	[mobileMq]: {
		gridTemplateColumns: '1fr',
	},
}

/* Form panel */
const authPanelCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	justifyContent: 'center',
	gap: '2rem',
	padding: 'clamp(1.5rem, 4vw, 3rem)',
	position: 'relative' as const,
	backgroundColor: colors.surface,
	[mobileMq]: {
		justifyContent: 'flex-start',
		/* Was clamp(4.5rem, 12vw, 6rem) to clear the absolutely positioned
		   corner. The corner is hidden at this breakpoint now, so the panel only
		   needs its own breathing room. */
		paddingTop: 'clamp(1.75rem, 6vw, 2.75rem)',
	},
}

const authCardCss = {
	width: 'min(100%, 400px)',
	marginInline: 'auto',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '1.7rem',
}

const authHeadCss = {
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.9rem, 3vw, 2.3rem)',
		fontWeight: 760,
		letterSpacing: '-0.025em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.5rem 0 0',
		color: colors.textMuted,
	},
	/* Centred on phones to sit under the centred brand mark; the two-panel
	   desktop layout keeps the heading left-aligned with the form below it. */
	[mobileMq]: {
		textAlign: 'center' as const,
	},
}

const authDividerCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	color: colors.textMuted,
	fontSize: '0.88rem',
	'&::before': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
	'&::after': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
}

const authOauthCss = {
	display: 'flex',
	justifyContent: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

const oauthButtonCss = {
	...getGhostButtonCss(),
	flex: '0 0 auto',
	width: '3rem',
	height: '3rem',
	minWidth: '3rem',
	padding: 0,
	'& svg': {
		display: 'block',
		flexShrink: 0,
	},
}

const authFootCss = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: '1.3rem',
	display: 'grid',
	gap: '0.6rem',
	'& p': {
		margin: 0,
		fontSize: '0.95rem',
		color: colors.textMuted,
		textAlign: 'center' as const,
		marginInline: 'auto',
	},
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
}

const authLegalCss = {
	display: 'flex',
	justifyContent: 'center',
	gap: '1.1rem',
	fontSize: '0.85rem',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
	'& a:hover': { textDecoration: 'underline', color: colors.text },
}

const authCornerCss = {
	position: 'absolute' as const,
	top: 'clamp(1rem, 2.5vw, 1.8rem)',
	right: 'clamp(1rem, 2.5vw, 1.8rem)',
	display: 'flex',
	alignItems: 'center',
	gap: '1.1rem',
	fontSize: '0.92rem',
	'& > a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
	'& > a:hover': { color: colors.text },
	/*
	 * Gone on phones, where this floated over the top of the card and crowded
	 * the brand. The "back" link is redundant there because `authBrandMobileCss`
	 * puts a real link home inside the card at this breakpoint — which is also
	 * why the corner has to stay on wider screens, where that in-card brand is
	 * `display: none` and the only other one is inside the `aria-hidden` visual
	 * panel at `tabIndex={-1}`. Hiding it there would leave no reachable way
	 * home.
	 */
	[mobileMq]: { display: 'none' },
}
