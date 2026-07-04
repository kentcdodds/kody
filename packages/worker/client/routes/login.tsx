import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	getPathname,
	listenToRouterNavigation,
} from '#client/client-router.tsx'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { fetchSessionInfo, type SessionStatus } from '#client/session.ts'
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

type AuthMode = 'login' | 'signup'
type AuthStatus = 'idle' | 'submitting' | 'success' | 'error'

function normalizeRedirectTo(value: string | null) {
	if (!value) return null
	if (!value.startsWith('/')) return null
	if (value.startsWith('//')) return null
	return value
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

export function LoginRoute(handle: Handle) {
	let status: AuthStatus = 'idle'
	let message: string | null = null
	let sessionStatus: SessionStatus = 'idle'
	let sessionEmail = ''
	let activeMode = getCurrentAuthMode(handle)
	let routePath: string | null = null

	function setState(nextStatus: AuthStatus, nextMessage: string | null = null) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	function resetAuthState() {
		status = 'idle'
		message = null
	}

	listenToRouterNavigation(handle, () => {
		if (!routePath) return
		if (getPathname(handle) !== routePath) {
			resetAuthState()
		}
	})

	if (typeof document !== 'undefined') {
		handle.queueTask(async (signal) => {
			if (sessionStatus !== 'idle') return
			sessionStatus = 'loading'

			const session = await fetchSessionInfo(signal)
			if (signal.aborted) return
			sessionEmail = session?.email ?? ''

			sessionStatus = 'ready'
			if (sessionEmail) {
				window.location.assign(getCurrentRedirectTo(handle) ?? '/account')
				return
			}
			handle.update()
		})
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
					...(mode === 'signup' ? { username } : {}),
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
				window.location.assign(getCurrentRedirectTo(handle) ?? '/account')
			}
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		const mode = getCurrentAuthMode(handle)
		if (!routePath) {
			routePath = getPathname(handle)
		}
		if (mode !== activeMode) {
			activeMode = mode
			resetAuthState()
		}
		const redirectTo = getCurrentRedirectTo(handle)
		const isSignup = mode === 'signup'
		const isSubmitting = status === 'submitting'
		const title = isSignup ? 'Create your account' : 'Welcome back'
		const description = isSignup
			? 'Sign up to start using kody.'
			: 'Log in to continue to kody.'
		const submitLabel = isSignup ? 'Create account' : 'Sign in'
		const toggleLabel = isSignup
			? 'Already have an account?'
			: 'Need an account?'
		const toggleAction = isSignup ? 'Sign in instead' : 'Sign up instead'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h2 mix={css(pageTitleCss)}>{title}</h2>
					<p mix={css(pageDescriptionCss)}>{description}</p>
				</header>
				<form mix={[css(cardCss), on('submit', handleSubmit)]}>
					{isSignup ? (
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
							autoFocus={!isSignup}
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
							autoComplete={isSignup ? 'new-password' : 'current-password'}
							placeholder="At least 8 characters"
							mix={css(inputCss)}
						/>
					</label>
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
								mix={css({
									marginTop: '0.15rem',
								})}
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

const actionLinkCss = {
	...primaryLinkCss,
	textAlign: 'left' as const,
}
