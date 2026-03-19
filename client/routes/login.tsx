import { type Handle } from 'remix/component'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	getPathname,
	listenToRouterNavigation,
} from '#client/client-router.tsx'
import { fetchSessionInfo, type SessionStatus } from '#client/session.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'

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
			<section
				css={{
					maxWidth: '28rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.lg,
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<h2
						css={{
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						{title}
					</h2>
					<p css={{ color: colors.textMuted }}>{description}</p>
				</header>
				<form
					css={{
						display: 'grid',
						gap: spacing.md,
						padding: spacing.lg,
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
					}}
					on={{ submit: handleSubmit }}
				>
					<label css={{ display: 'grid', gap: spacing.xs }}>
						<span
							css={{
								color: colors.text,
								fontWeight: typography.fontWeight.medium,
								fontSize: typography.fontSize.sm,
							}}
						>
							Email
						</span>
						<input
							type="email"
							name="email"
							required
							autoFocus
							autoComplete="email"
							placeholder="you@example.com"
							css={{
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontSize: typography.fontSize.base,
								fontFamily: typography.fontFamily,
							}}
						/>
					</label>
					<label css={{ display: 'grid', gap: spacing.xs }}>
						<span
							css={{
								color: colors.text,
								fontWeight: typography.fontWeight.medium,
								fontSize: typography.fontSize.sm,
							}}
						>
							Password
						</span>
						<input
							type="password"
							name="password"
							required
							autoComplete={isSignup ? 'new-password' : 'current-password'}
							placeholder="At least 8 characters"
							css={{
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontSize: typography.fontSize.base,
								fontFamily: typography.fontFamily,
							}}
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
					<button
						type="submit"
						disabled={isSubmitting}
						css={{
							padding: `${spacing.sm} ${spacing.lg}`,
							borderRadius: radius.full,
							border: 'none',
							backgroundColor: colors.primary,
							color: colors.onPrimary,
							fontSize: typography.fontSize.base,
							fontWeight: typography.fontWeight.semibold,
							cursor: isSubmitting ? 'not-allowed' : 'pointer',
							opacity: isSubmitting ? 0.7 : 1,
							transition: `transform ${transitions.fast}, background-color ${transitions.normal}`,
							'&:hover': isSubmitting
								? undefined
								: {
										backgroundColor: colors.primaryHover,
										transform: 'translateY(-1px)',
									},
							'&:active': isSubmitting
								? undefined
								: {
										backgroundColor: colors.primaryActive,
										transform: 'translateY(0)',
									},
						}}
					>
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
						css={{
							background: 'none',
							border: 'none',
							padding: 0,
							color: colors.primaryText,
							fontSize: typography.fontSize.sm,
							cursor: 'pointer',
							textAlign: 'left',
							textDecoration: 'none',
							'&:hover': {
								textDecoration: 'underline',
							},
						}}
					>
						{toggleLabel} {toggleAction}
					</a>
					{!isSignup ? (
						<a
							href="/reset-password"
							css={{
								background: 'none',
								border: 'none',
								padding: 0,
								color: colors.primaryText,
								fontSize: typography.fontSize.sm,
								cursor: 'pointer',
								textAlign: 'left',
								textDecoration: 'none',
								'&:hover': {
									textDecoration: 'underline',
								},
							}}
						>
							Forgot password?
						</a>
					) : null}
					<a
						href="/"
						css={{
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
							textDecoration: 'none',
							'&:hover': {
								textDecoration: 'underline',
							},
						}}
					>
						Back home
					</a>
				</div>
			</section>
		)
	}
}
