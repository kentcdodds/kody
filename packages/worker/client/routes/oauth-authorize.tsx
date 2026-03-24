import { type Handle } from 'remix/component'
import {
	fetchSessionInfo,
	type SessionInfo,
	type SessionStatus,
} from '#client/session.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#client/styles/tokens.ts'

type OAuthAuthorizeInfo = {
	client: { id: string; name: string }
	scopes: Array<string>
}

type OAuthAuthorizeStatus = 'idle' | 'loading' | 'ready' | 'error'
type OAuthAuthorizeMessage = { type: 'error' | 'info'; text: string }

function getSearchParams() {
	return typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search)
}

export function OAuthAuthorizeRoute(handle: Handle) {
	let info: OAuthAuthorizeInfo | null = null
	let status: OAuthAuthorizeStatus = 'idle'
	let message: OAuthAuthorizeMessage | null = null
	let submitting = false
	let lastSearch = ''
	let session: SessionInfo | null = null
	let sessionStatus: SessionStatus = 'idle'

	function setMessage(next: OAuthAuthorizeMessage | null) {
		message = next
		handle.update()
	}

	function readQueryError() {
		const params = getSearchParams()
		const description = params.get('error_description')
		if (description) return description
		const error = params.get('error')
		return error ? `Authorization error: ${error}` : null
	}

	async function loadInfo() {
		status = 'loading'

		const queryError = readQueryError()
		if (queryError) {
			message = { type: 'error', text: queryError }
		}

		try {
			const query = typeof window === 'undefined' ? '' : window.location.search
			const response = await fetch(`/oauth/authorize-info${query}`, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok || !payload?.ok) {
				const errorText =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to load authorization details.'
				info = null
				status = 'error'
				message = { type: 'error', text: errorText }
				handle.update()
				return
			}
			info = {
				client: payload.client,
				scopes: payload.scopes,
			}
			status = 'ready'
			if (!queryError) {
				message = null
			}
			handle.update()
		} catch {
			info = null
			status = 'error'
			message = {
				type: 'error',
				text: 'Unable to load authorization details.',
			}
			handle.update()
		}
	}

	async function loadSession() {
		if (sessionStatus !== 'idle') return
		sessionStatus = 'loading'

		session = await fetchSessionInfo()

		sessionStatus = 'ready'
		handle.update()
	}

	async function submitDecision(
		decision: 'approve' | 'deny',
		form?: HTMLFormElement,
	) {
		if (submitting) return
		submitting = true
		handle.update()

		try {
			const body = new URLSearchParams()
			body.set('decision', decision)
			if (decision === 'approve' && form) {
				const formData = new FormData(form)
				const email = String(formData.get('email') ?? '').trim()
				const password = String(formData.get('password') ?? '')
				if (!email || !password) {
					setMessage({
						type: 'error',
						text: 'Email and password are required.',
					})
					submitting = false
					handle.update()
					return
				}
				body.set('email', email)
				body.set('password', password)
			}
			const response = await fetch(window.location.href, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				credentials: 'include',
				body,
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok) {
				const errorText =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to complete authorization.'
				setMessage({ type: 'error', text: errorText })
				submitting = false
				handle.update()
				return
			}
			if (payload?.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			setMessage({ type: 'error', text: 'Missing redirect response.' })
		} catch {
			setMessage({
				type: 'error',
				text: 'Network error. Please try again.',
			})
		} finally {
			submitting = false
			handle.update()
		}
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const hasSession = Boolean(session?.email)
		await submitDecision(
			'approve',
			hasSession ? undefined : event.currentTarget,
		)
	}

	return () => {
		const currentSearch =
			typeof window === 'undefined' ? '' : window.location.search
		if (currentSearch !== lastSearch) {
			lastSearch = currentSearch
			void loadInfo()
		}
		if (sessionStatus === 'idle') {
			void loadSession()
		}

		const clientLabel = info?.client?.name ?? 'Unknown client'
		const scopes = info?.scopes ?? []
		const scopeLabel =
			scopes.length > 0 ? scopes.join(', ') : 'No scopes requested.'
		const sessionEmail = session?.email ?? ''
		const isSessionReady = sessionStatus === 'ready'
		const isSessionLoading =
			sessionStatus === 'loading' || sessionStatus === 'idle'
		const isLoggedIn = isSessionReady && Boolean(sessionEmail)
		const actionsDisabled = status !== 'ready' || submitting || isSessionLoading
		const formReady = status === 'ready' && !isSessionLoading
		const authorizeLabel = submitting
			? 'Submitting...'
			: isLoggedIn
				? 'Approve connection'
				: 'Authorize'

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
						Authorize access
					</h2>
					<p css={{ color: colors.textMuted }}>
						{clientLabel} wants to access your kody account.
					</p>
				</header>
				<section
					css={{
						padding: spacing.lg,
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
						display: 'grid',
						gap: spacing.sm,
					}}
				>
					<p
						css={{
							margin: 0,
							fontWeight: typography.fontWeight.medium,
							color: colors.text,
						}}
					>
						Requested scopes
					</p>
					<p css={{ margin: 0, color: colors.textMuted }}>{scopeLabel}</p>
				</section>
				{isSessionLoading ? (
					<p css={{ color: colors.textMuted }}>Checking your session…</p>
				) : null}
				{isLoggedIn ? (
					<section
						css={{
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.surface,
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						<p
							css={{
								margin: 0,
								fontWeight: typography.fontWeight.medium,
								color: colors.text,
							}}
						>
							Signed in as {sessionEmail}
						</p>
						<p css={{ margin: 0, color: colors.textMuted }}>
							Approve to continue with this account.
						</p>
					</section>
				) : null}
				{status === 'loading' ? (
					<p css={{ color: colors.textMuted }}>
						Loading authorization details…
					</p>
				) : null}
				{message ? (
					<p
						css={{
							color: message.type === 'error' ? colors.error : colors.text,
							fontSize: typography.fontSize.sm,
						}}
						role={message.type === 'error' ? 'alert' : undefined}
					>
						{message.text}
					</p>
				) : null}
				<form
					css={{
						display: 'grid',
						gap: spacing.md,
						padding: spacing.lg,
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
						opacity: formReady ? 1 : 0.7,
					}}
					on={{ submit: handleSubmit }}
				>
					{!isLoggedIn && isSessionReady ? (
						<>
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
									autoComplete="email"
									placeholder="you@example.com"
									disabled={actionsDisabled}
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
									autoComplete="current-password"
									placeholder="Enter your password"
									disabled={actionsDisabled}
									css={{
										padding: spacing.sm,
										borderRadius: radius.md,
										border: `1px solid ${colors.border}`,
										fontSize: typography.fontSize.base,
										fontFamily: typography.fontFamily,
									}}
								/>
							</label>
						</>
					) : null}
					<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
						<button
							type="submit"
							disabled={actionsDisabled}
							css={{
								padding: `${spacing.sm} ${spacing.lg}`,
								borderRadius: radius.full,
								border: 'none',
								backgroundColor: colors.primary,
								color: colors.onPrimary,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.semibold,
								cursor: actionsDisabled ? 'not-allowed' : 'pointer',
								opacity: actionsDisabled ? 0.7 : 1,
							}}
						>
							{authorizeLabel}
						</button>
						<button
							type="button"
							disabled={actionsDisabled}
							on={{ click: () => submitDecision('deny') }}
							css={{
								padding: `${spacing.sm} ${spacing.lg}`,
								borderRadius: radius.full,
								border: `1px solid ${colors.border}`,
								backgroundColor: 'transparent',
								color: colors.text,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.medium,
								cursor: actionsDisabled ? 'not-allowed' : 'pointer',
								opacity: actionsDisabled ? 0.7 : 1,
							}}
						>
							Deny
						</button>
					</div>
				</form>
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
			</section>
		)
	}
}
