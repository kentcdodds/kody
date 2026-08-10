import { startAuthentication } from '@simplewebauthn/browser'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	getPathname,
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { HeroStage } from '#client/hero-stage.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import { fetchSessionInfo, type SessionStatus } from '#client/session.ts'
import {
	fetchPublicAuthConfig,
	startSocialSignIn,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { type SignupMode } from '#universal/signup-mode.ts'
import { ThemeToggle } from '#client/theme-toggle.tsx'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
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

type AuthMode = 'login' | 'signup'
type AuthStatus = 'idle' | 'submitting' | 'success' | 'error'
type SignupPanel = 'waiting-list' | 'invite' | 'open'

function shouldOpenInviteSignup(searchParams: URLSearchParams) {
	if (searchParams.has('code') || searchParams.has('invite')) return true
	const panel = searchParams.get('panel')
	return panel === 'invite' || panel === 'code'
}

function readPrefillInviteCode(searchParams: URLSearchParams) {
	for (const key of ['code', 'invite'] as const) {
		const value = searchParams.get(key)?.trim()
		if (value) return value
	}
	return ''
}

function resolveSignupPanel(
	searchParams: URLSearchParams,
	signupMode: SignupMode,
): SignupPanel {
	if (shouldOpenInviteSignup(searchParams)) return 'invite'
	if (searchParams.get('panel') === 'waiting-list') return 'waiting-list'
	return signupMode === 'waitlist' ? 'waiting-list' : signupMode
}

function buildAuthPath(mode: AuthMode, redirectTo: string | null) {
	const path = mode === 'signup' ? '/signup' : '/login'
	return buildAuthLink(path, redirectTo)
}

function buildInviteSignupPath(redirectTo: string | null) {
	const params = new URLSearchParams()
	if (redirectTo) params.set('redirectTo', redirectTo)
	params.set('panel', 'invite')
	return `/signup?${params.toString()}`
}

function getAuthModeFromPathname(pathname: string): AuthMode {
	return pathname === '/signup' ? 'signup' : 'login'
}

function getSearchParams(handle: Handle) {
	return new URLSearchParams(readRouterSearch(handle))
}

function getCurrentAuthMode(handle: Handle) {
	return getAuthModeFromPathname(readRouterPathname(handle))
}

function getCurrentRedirectTo(handle: Handle) {
	return normalizeRedirectTo(getSearchParams(handle).get('redirectTo'))
}

/**
 * SPA navigations to /login and /signup prefetch the enabled providers so
 * the buttons render with the rest of the page (full-document loads embed
 * the same payload during SSR).
 */
export async function authProvidersRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const config = await fetchPublicAuthConfig(signal)
	// A failed fetch yields no loader data, so the route's fallback fetch
	// retries instead of rendering a permanently button-less page.
	if (!config) return {}
	return { authProviders: { ok: true, ...config } }
}

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

		const formData = new FormData(event.currentTarget)
		const email = String(formData.get('email') ?? '').trim()
		const password = String(formData.get('password') ?? '')
		const mode = getCurrentAuthMode(handle)
		const username =
			mode === 'signup' ? String(formData.get('username') ?? '').trim() : ''
		const inviteCode =
			mode === 'signup' ? String(formData.get('inviteCode') ?? '').trim() : ''
		const rememberMe = mode === 'login' && formData.get('rememberMe') === 'on'
		const protection = readPublicFormProtection(formData)

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
				? readPublicFormProtection(new FormData(authForm))
				: { website: '', turnstileToken: '' }
			const errorMessage = await startSocialSignIn(
				providerId,
				getCurrentRedirectTo(handle),
				inviteCode,
				protection,
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
				? readPublicFormProtection(new FormData(authForm))
				: { website: '', turnstileToken: '' }

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

	function renderBrand(
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

	function renderStatusMessage() {
		return (
			<>
				{/*
				 * A live region only announces text that changes while the
				 * region is already in the accessibility tree, so the announcer
				 * stays mounted for the life of the form and keeps one fixed
				 * role. It is out of flow, so it costs no flex gap while empty.
				 */}
				<p role="status" mix={css(visuallyHiddenCss)}>
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

	function renderHoneypot() {
		return (
			<input
				type="text"
				name={honeypotFieldName}
				tabIndex={-1}
				autoComplete="off"
				aria-hidden="true"
				mix={css(honeypotCss)}
			/>
		)
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
				{/* ============ brand panel ============ */}
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

				{/* ============ form panel ============ */}
				<div mix={css(authPanelCss)}>
					{renderBrand(authBrandMobileCss)}

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

						{showWaitingList ? (
							<form
								key="waiting-list"
								data-rise
								method="post"
								style={{ '--rise': '1' }}
								mix={[css(authFormCss), on('submit', handleWaitingListSubmit)]}
							>
								{renderHoneypot()}
								<div mix={css(authFieldCss)}>
									<label
										for={`${handle.id}-first-name`}
										mix={css(authFieldLabelCss)}
									>
										First name
									</label>
									<input
										id={`${handle.id}-first-name`}
										type="text"
										name="firstName"
										required
										autoFocus
										autoComplete="given-name"
										maxLength={80}
										placeholder="Ada"
										data-field-ring
										mix={css(authInputCss)}
									/>
								</div>
								<div mix={css(authFieldCss)}>
									<label
										for={`${handle.id}-waitlist-email`}
										mix={css(authFieldLabelCss)}
									>
										Email
									</label>
									<input
										id={`${handle.id}-waitlist-email`}
										type="email"
										name="email"
										required
										autoComplete="email"
										placeholder="you@yourdomain.dev"
										data-field-ring
										mix={css(authInputCss)}
									/>
								</div>
								{turnstileSiteKey ? (
									<div class={turnstileWidgetClassName}></div>
								) : null}
								{renderStatusMessage()}
								<button
									type={status === 'success' ? 'button' : 'submit'}
									aria-disabled={
										isSubmitting || status === 'success' ? 'true' : undefined
									}
									aria-busy={isSubmitting ? 'true' : undefined}
									mix={css(authSubmitCss)}
								>
									<span
										data-swap-label
										data-active={isSubmitting ? undefined : true}
										aria-hidden={isSubmitting ? 'true' : undefined}
									>
										Join the waiting list
									</span>
									<span
										data-swap-label
										data-active={isSubmitting ? true : undefined}
										aria-hidden={isSubmitting ? undefined : 'true'}
									>
										Joining…
									</span>
								</button>
							</form>
						) : (
							<form
								key="authentication"
								data-public-auth-form
								data-rise
								method="post"
								style={{ '--rise': '1' }}
								mix={[css(authFormCss), on('submit', handleSubmit)]}
							>
								{renderHoneypot()}
								{isSignup ? (
									<div mix={css(authFieldCss)}>
										<label
											for={`${handle.id}-username`}
											mix={css(authFieldLabelCss)}
										>
											Username
										</label>
										<input
											id={`${handle.id}-username`}
											type="text"
											name="username"
											required
											autoFocus
											autoComplete="username"
											pattern={'[A-Za-z0-9][A-Za-z0-9_\\-]{1,30}[A-Za-z0-9]'}
											title="Use 3 to 32 letters, numbers, hyphens, or underscores. Start and end with a letter or number."
											placeholder="kent"
											data-field-ring
											mix={css(authInputCss)}
										/>
									</div>
								) : null}
								<div mix={css(authFieldCss)}>
									<label
										for={`${handle.id}-email`}
										mix={css(authFieldLabelCss)}
									>
										Email
									</label>
									<input
										id={`${handle.id}-email`}
										type="email"
										name="email"
										required
										autoFocus={!isSignup}
										autoComplete="email"
										placeholder="you@yourdomain.dev"
										data-field-ring
										mix={css(authInputCss)}
									/>
								</div>
								<div mix={css(authFieldCss)}>
									{isSignup ? (
										<label
											for={`${handle.id}-password`}
											mix={css(authFieldLabelCss)}
										>
											Password
										</label>
									) : (
										<div mix={css(authFieldLabelRowCss)}>
											<label
												for={`${handle.id}-password`}
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
										id={`${handle.id}-password`}
										type="password"
										name="password"
										required
										autoComplete={
											isSignup ? 'new-password' : 'current-password'
										}
										placeholder={isSignup ? 'At least 8 characters' : undefined}
										data-field-ring
										mix={css(authInputCss)}
									/>
								</div>
								{showInviteSignup ? (
									<div mix={css(authFieldCss)}>
										<label
											for={`${handle.id}-invite-code`}
											mix={css(authFieldLabelCss)}
										>
											Invite code
										</label>
										<input
											id={`${handle.id}-invite-code`}
											type="text"
											name="inviteCode"
											defaultValue={prefillInviteCode}
											autoComplete="one-time-code"
											placeholder="Enter your invite code"
											data-field-ring
											mix={css(authInputCss)}
										/>
									</div>
								) : null}
								{turnstileSiteKey ? (
									<div class={turnstileWidgetClassName}></div>
								) : null}
								{!isSignup ? (
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
								{renderStatusMessage()}
								<button
									type="submit"
									disabled={isSubmitting}
									mix={css(authSubmitCss)}
								>
									<span
										data-swap-label
										data-active={isSubmitting ? undefined : true}
										aria-hidden={isSubmitting ? 'true' : undefined}
									>
										{submitLabel}
									</span>
									<span
										data-swap-label
										data-active={isSubmitting ? true : undefined}
										aria-hidden={isSubmitting ? undefined : 'true'}
									>
										{submitBusyLabel}
									</span>
								</button>
								{!isSignup ? (
									<button
										type="button"
										disabled={isSubmitting}
										mix={[
											css(ghostButtonCss),
											on('click', handlePasskeySignIn),
										]}
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
						)}

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
											mix={[
												css(oauthButtonCss),
												on('click', () => handleProviderSignIn(provider.id)),
											]}
										>
											<ProviderIcon providerId={provider.id} />
											<span mix={css(visuallyHiddenCss)}>Continue with </span>
											{provider.label}
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
						<ThemeToggle />
					</div>
				</div>
			</div>
		)
	}
}

/* ---------- styles ---------- */

const motionOk = '@media (prefers-reduced-motion: no-preference)'
const mobileMq = '@media (max-width: 900px)'

const authLayoutCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
	width: '100%',
	[mobileMq]: {
		gridTemplateColumns: '1fr',
	},
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
	'& img': { borderRadius: '50%' },
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
const formMessageCss = {
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

const ghostButtonCss = getGhostButtonCss()

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
	/*
	 * `authProviders` comes from deployment config, so the count varies. Three
	 * short labels still fit the 400px card, but each button is `flex: 1 1 0`
	 * with `minWidth: 0` and no `text-overflow`, so a fourth provider would
	 * squeeze them past their labels. Wrapping moves the extras to a new row.
	 */
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

const oauthButtonCss = {
	...getGhostButtonCss(),
	flex: '1 1 0',
	minWidth: 0,
	fontSize: '0.95rem',
	paddingInline: '0.6rem',
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
	 * home. The theme toggle goes with it; the theme still follows the system
	 * preference, and this is a screen you pass through.
	 */
	[mobileMq]: { display: 'none' },
}

const honeypotCss = {
	position: 'absolute' as const,
	left: '-10000px',
	width: '1px',
	height: '1px',
	overflow: 'hidden' as const,
}
