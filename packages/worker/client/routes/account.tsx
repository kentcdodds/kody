import { type Handle } from 'remix/component'
import { colors, spacing, typography } from '#client/styles/tokens.ts'

type AccountStatus = 'idle' | 'loading' | 'ready' | 'error'

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let message: string | null = null

	async function loadAccount(signal: AbortSignal) {
		try {
			const response = await fetch('/session', {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			const payload = await response.json().catch(() => null)
			const sessionEmail =
				response.ok &&
				payload?.ok &&
				typeof payload?.session?.email === 'string'
					? payload.session.email.trim()
					: ''
			if (!sessionEmail) {
				window.location.assign('/login')
				return
			}
			email = sessionEmail
			status = 'ready'
			message = null
			handle.update()
		} catch {
			if (signal.aborted) return
			status = 'error'
			message = 'Unable to load your account.'
			handle.update()
		}
	}

	return () => {
		if (status === 'loading') {
			handle.queueTask(loadAccount)
		}

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
					<h1
						css={{
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
							margin: 0,
						}}
					>
						{email ? `Welcome, ${email}` : 'Welcome'}
					</h1>
					<p css={{ color: colors.textMuted }}>You are signed in to kody.</p>
				</header>
				{status === 'loading' ? (
					<p css={{ color: colors.textMuted }}>Loading your account…</p>
				) : null}
				{message ? (
					<p css={{ color: colors.error }} role="alert">
						{message}
					</p>
				) : null}
			</section>
		)
	}
}
