import { type Handle } from 'remix/component'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	getPathname,
	listenToRouterNavigation,
} from '#client/client-router.tsx'
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

function getSearchParams() {
	return typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search)
}

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

function getCurrentAuthMode() {
	return getAuthModeFromPathname(getPathname())
}

function getCurrentRedirectTo() {
	return normalizeRedirectTo(getSearchParams().get('redirectTo'))
}

export function LoginRoute(handle: Handle) {
	let status: AuthStatus = 'idle'
	let message: string | null = null
	let sessionStatus: SessionStatus = 'idle'
	let sessionEmail = ''
	let activeMode = getCurrentAuthMode()
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
		if (getPathname() !== routePath) {
			resetAuthState()
		}
	})

	handle.queueTask(async (signal) => {
		if (sessionStatus !== 'idle') return
		sessionStatus = 'loading'

		const session = await fetchSessionInfo(signal)
		if (signal.aborted) return
		sessionEmail = session?.email ?? ''

		sessionStatus = 'ready'
		if (sessionEmail && typeof window !== 'undefined') {
			window.location.assign(getCurrentRedirectTo() ?? '/account')
			return
		}
		handle.update()
	})

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const email = String(formData.get('email') ?? '').trim()
		const password = String(formData.get('password') ?? '')
		const mode = getCurrentAuthMode()
		const rememberMe = mode === 'login' && formData.get('rememberMe') === 'on'

		if (!email || !password) {
			setState('error', 'Email and password are required.')
			return
		}

		setState('submitting')

		try {
			const response = await fetch('/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ email, password, mode, rememberMe }),
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
				window.location.assign(getCurrentRedirectTo() ?? '/account')
			}
		} catch {
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		const mode = getCurrentAuthMode()
		if (!routePath) {
			routePath = getPathname()
		}
		if (mode !== activeMode) {
			activeMode = mode
			resetAuthState()
		}
		const redirectTo = getCurrentRedirectTo()
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
			<section css={pageCss}>
				<header css={pageHeaderCss}>
					<h2 css={pageTitleCss}>{title}</h2>
					<p css={pageDescriptionCss}>{description}</p>
				</header>
				<form css={cardCss} on={{ submit: handleSubmit }}>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Email</span>
						<input
							type="email"
							name="email"
							required
							autoFocus
							autoComplete="email"
							placeholder="you@example.com"
							css={inputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Password</span>
						<input
							type="password"
							name="password"
							required
							autoComplete={isSignup ? 'new-password' : 'current-password'}
							placeholder="At least 8 characters"
							css={inputCss}
						/>
					</label>
					{!isSignup ? (
						<label
							css={{
								display: 'flex',
								gap: spacing.sm,
								alignItems: 'flex-start',
								color: colors.text,
							}}
						>
							<input
								type="checkbox"
								name="rememberMe"
								css={{
									marginTop: '0.15rem',
								}}
							/>
							<span css={{ display: 'grid', gap: spacing.xs }}>
								<span
									css={{
										fontWeight: typography.fontWeight.medium,
										fontSize: typography.fontSize.sm,
									}}
								>
									Remember me
								</span>
								<span
									css={{
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									}}
								>
									Stay signed in for 30 days. Active sessions renew after 14
									days.
								</span>
							</span>
						</label>
					) : null}
					<button type="submit" disabled={isSubmitting} css={primaryButtonCss}>
						{isSubmitting ? 'Submitting...' : submitLabel}
					</button>
					{message ? (
						<p
							css={{
								color: status === 'error' ? colors.error : colors.text,
								fontSize: typography.fontSize.sm,
							}}
							aria-live="polite"
						>
							{message}
						</p>
					) : null}
				</form>
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<a
						href={buildAuthPath(isSignup ? 'login' : 'signup', redirectTo)}
						aria-pressed={isSignup}
						css={actionLinkCss}
					>
						{toggleLabel} {toggleAction}
					</a>
					{!isSignup ? (
						<a href="/reset-password" css={actionLinkCss}>
							Forgot password?
						</a>
					) : null}
					<a href="/" css={mutedLinkCss}>
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
