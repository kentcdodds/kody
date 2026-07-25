import { startAuthentication } from '@simplewebauthn/browser'
import { type Handle, css } from 'remix/ui'
import checkbox from 'remix/ui/checkbox'
import { on } from '#client/event-mixin.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import {
	getPathname,
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { getOauthLoginErrorMessage } from '#app/oauth-login-errors.ts'
import { fetchSessionInfo, type SessionStatus } from '#client/session.ts'
import {
	fetchEnabledAuthProviders,
	startSocialSignIn,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	primaryLinkCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

type AuthMode = 'login' | 'signup'
type AuthStatus = 'idle' | 'submitting' | 'success' | 'error'
type SignupPanel = 'waiting-list' | 'invite'

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

function resolveSignupPanel(searchParams: URLSearchParams): SignupPanel {
	return shouldOpenInviteSignup(searchParams) ? 'invite' : 'waiting-list'
}

function buildAuthPath(mode: AuthMode, redirectTo: string | null) {
	const path = mode === 'signup' ? '/signup' : '/login'
	return buildAuthLink(path, redirectTo)
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
	const providers = await fetchEnabledAuthProviders(signal)
	// A failed fetch yields no loader data, so the route's fallback fetch
	// retries instead of rendering a permanently button-less page.
	if (!providers) return {}
	return { authProviders: { ok: true, providers } }
}

export function LoginRoute(handle: Handle) {
	let status: AuthStatus = 'idle'
	let message: string | null = null
	let sessionStatus: SessionStatus = 'idle'
	let sessionEmail = ''
	let authProviders: Array<AuthProviderInfo> = []
	// True once the provider list came from SSR-embedded or SPA-preloaded
	// loader data (the normal paths); the client fetch is a fallback only.
	let authProvidersReady = false
	let activeMode = getCurrentAuthMode(handle)
	let routePath: string | null = null
	let activeSignupSearch = readRouterSearch(handle)
	let signupPanel: SignupPanel = resolveSignupPanel(getSearchParams(handle))
	let prefillInviteCode = readPrefillInviteCode(getSearchParams(handle))

	function setState(nextStatus: AuthStatus, nextMessage: string | null = null) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	function resetAuthState() {
		status = 'idle'
		message = null
	}

	function applySignupSearch(searchParams: URLSearchParams) {
		signupPanel = resolveSignupPanel(searchParams)
		prefillInviteCode = readPrefillInviteCode(searchParams)
	}

	function setSignupPanel(nextPanel: SignupPanel) {
		signupPanel = nextPanel
		resetAuthState()
		handle.update()
	}

	listenToRouterNavigation(handle, () => {
		if (!routePath) return
		if (getPathname(handle) !== routePath) {
			resetAuthState()
		}
	})

	async function loadSessionAndProviders(signal: AbortSignal) {
		if (sessionStatus !== 'idle') return
		sessionStatus = 'loading'

		const [session, providers] = await Promise.all([
			fetchSessionInfo(signal),
			authProvidersReady ? null : fetchEnabledAuthProviders(signal),
		])
		if (signal.aborted) {
			// Hydration re-renders abort in-flight queued tasks; reset so the
			// next render re-queues the load instead of stalling on 'loading'.
			sessionStatus = 'idle'
			return
		}
		sessionEmail = session?.email ?? ''
		if (providers && !authProvidersReady) {
			authProviders = providers
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
				setState('error', errorMessage)
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
			setState('error', 'Network error. Please try again.')
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
			const errorMessage = await startSocialSignIn(
				providerId,
				getCurrentRedirectTo(handle),
				inviteCode,
			)
			if (errorMessage) {
				setState('error', errorMessage)
			}
			// On success the browser is navigating to the provider; leave the
			// submitting state in place.
		} catch {
			setState('error', 'Network error. Please try again.')
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

			const verificationResponse = await fetch('/webauthn/authentication', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					response: authenticationResponse,
					rememberMe,
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
				setState('error', errorMessage)
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
			setState('error', 'Network error. Please try again.')
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
				authProvidersReady = true
			}
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
				? 'Use your invite code to create an account and start building automations you own.'
				: 'Log in to keep building automations you own.'
		const submitLabel = isSignup ? 'Create account' : 'Sign in'
		const toggleLabel = isSignup
			? 'Already have an account?'
			: 'Need an account?'
		const toggleAction = isSignup ? 'Sign in instead' : 'Join the waitlist'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h2 mix={css(pageTitleCss)}>{title}</h2>
					<p mix={css(pageDescriptionCss)}>{description}</p>
				</header>
				{oauthErrorMessage ? (
					<p
						aria-live="polite"
						mix={css({
							color: colors.error,
							fontSize: typography.fontSize.sm,
							margin: 0,
						})}
					>
						{oauthErrorMessage}
					</p>
				) : null}
				{showWaitingList ? (
					<form mix={[css(cardCss), on('submit', handleWaitingListSubmit)]}>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>First name</span>
							<input
								type="text"
								name="firstName"
								required
								autoFocus
								autoComplete="given-name"
								maxLength={80}
								placeholder="Ada"
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Email</span>
							<input
								type="email"
								name="email"
								required
								autoComplete="email"
								placeholder="you@example.com"
								mix={css(inputCss)}
							/>
						</label>
						<button
							type="submit"
							disabled={isSubmitting || status === 'success'}
							mix={css(primaryButtonCss)}
						>
							{isSubmitting ? 'Joining...' : 'Join waiting list'}
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
				) : (
					<form mix={[css(cardCss), on('submit', handleSubmit)]}>
						{showInviteSignup ? (
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Username</span>
								<input
									type="text"
									name="username"
									required
									autoFocus
									autoComplete="username"
									pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]"
									title="Use 3 to 32 letters, numbers, hyphens, or underscores. Start and end with a letter or number."
									placeholder="kent"
									mix={css(inputCss)}
								/>
							</label>
						) : null}
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Email</span>
							<input
								type="email"
								name="email"
								required
								autoFocus={!showInviteSignup}
								autoComplete="email"
								placeholder="you@example.com"
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Password</span>
							<input
								type="password"
								name="password"
								required
								autoComplete={
									showInviteSignup ? 'new-password' : 'current-password'
								}
								placeholder="At least 8 characters"
								mix={css(inputCss)}
							/>
						</label>
						{showInviteSignup ? (
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Invite code</span>
								<input
									type="text"
									name="inviteCode"
									defaultValue={prefillInviteCode}
									autoComplete="one-time-code"
									placeholder="Enter your invite code"
									mix={css(inputCss)}
								/>
							</label>
						) : null}
						{!isSignup ? (
							<label
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									alignItems: 'flex-start',
									color: colors.text,
								})}
							>
								<input
									type="checkbox"
									name="rememberMe"
									mix={[
										checkbox(),
										css({
											marginTop: '0.15rem',
										}),
									]}
								/>

								<span mix={css({ display: 'grid', gap: spacing.xs })}>
									<span
										mix={css({
											fontWeight: typography.fontWeight.medium,
											fontSize: typography.fontSize.sm,
										})}
									>
										Remember me
									</span>
									<span
										mix={css({
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										})}
									>
										Stay signed in for 30 days. Active sessions renew after 14
										days.
									</span>
								</span>
							</label>
						) : null}
						<button
							type="submit"
							disabled={isSubmitting}
							mix={css(primaryButtonCss)}
						>
							{isSubmitting ? 'Submitting...' : submitLabel}
						</button>
						{!isSignup ? (
							<button
								type="button"
								disabled={isSubmitting}
								mix={[
									css(secondaryButtonCss),
									on('click', handlePasskeySignIn),
								]}
							>
								Sign in with a passkey
							</button>
						) : null}
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
				)}
				{isSignup ? (
					<button
						type="button"
						disabled={isSubmitting}
						mix={[
							css(secondaryButtonCss),
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
				{!showWaitingList && authProviders.length > 0 ? (
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						<p
							mix={css({
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
								margin: 0,
								textAlign: 'center' as const,
							})}
						>
							or
						</p>
						{authProviders.map((provider) => (
							<button
								key={provider.id}
								type="button"
								disabled={isSubmitting}
								mix={[
									css(providerButtonCss),
									on('click', () => handleProviderSignIn(provider.id)),
								]}
							>
								<ProviderIcon providerId={provider.id} />
								Continue with {provider.label}
							</button>
						))}
					</div>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<a
						href={buildAuthPath(isSignup ? 'login' : 'signup', redirectTo)}
						aria-pressed={isSignup}
						mix={css(actionLinkCss)}
					>
						{toggleLabel} {toggleAction}
					</a>
					{!isSignup ? (
						<a href="/reset-password" mix={css(actionLinkCss)}>
							Forgot password?
						</a>
					) : null}
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>
					<a href="/terms" mix={css(mutedLinkCss)}>
						Terms
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

const secondaryButtonCss = getSecondaryButtonCss({ size: 'lg' })

const providerButtonCss = {
	...secondaryButtonCss,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: spacing.sm,
}

const actionLinkCss = {
	...primaryLinkCss,
	textAlign: 'left' as const,
}
