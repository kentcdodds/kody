import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	fetchSessionInfo,
	type SessionInfo,
	type SessionStatus,
} from '#client/session.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	inputCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	sectionTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

type OAuthAuthorizeInfo = {
	client: { id: string; name: string }
	scopes: Array<string>
}

type OAuthAuthorizeStatus = 'idle' | 'loading' | 'ready' | 'error'
type OAuthAuthorizeMessage = { type: 'error' | 'info'; text: string }
type OAuthAuthorizeDecision = 'approve' | 'deny' | 'reset-client'

function getSearchParams() {
	return typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search)
}

export function OAuthAuthorizeRoute(handle: Handle) {
	let info: OAuthAuthorizeInfo | null = null
	let status: OAuthAuthorizeStatus = 'idle'
	let message: OAuthAuthorizeMessage | null = null
	let submittingDecision: OAuthAuthorizeDecision | null = null
	let lastSearch = ''
	let session: SessionInfo | null = null
	let sessionStatus: SessionStatus = 'idle'
	let resetCompleted = false
	let allowClientReset = false
	let activeInfoRequestId = 0

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

	async function loadInfo(requestId: number) {
		try {
			const query = typeof window === 'undefined' ? '' : window.location.search
			const response = await fetch(`/oauth/authorize-info${query}`, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			const payload = await response.json().catch(() => null)
			if (requestId !== activeInfoRequestId) return
			if (!response.ok || !payload?.ok) {
				const errorText =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to load authorization details.'
				info = null
				status = 'error'
				allowClientReset = payload?.allowClientReset === true
				message = { type: 'error', text: errorText }
				handle.update()
				return
			}
			info = {
				client: payload.client,
				scopes: payload.scopes,
			}
			status = 'ready'
			allowClientReset = false
			message = null
			handle.update()
		} catch {
			if (requestId !== activeInfoRequestId) return
			info = null
			status = 'error'
			allowClientReset = false
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
		decision: OAuthAuthorizeDecision,
		form?: HTMLFormElement,
	) {
		if (submittingDecision) return
		submittingDecision = decision
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
					submittingDecision = null
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
				submittingDecision = null
				handle.update()
				return
			}
			if (payload?.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			if (typeof payload?.message === 'string') {
				resetCompleted = true
				submittingDecision = null
				setMessage({ type: 'info', text: payload.message })
				return
			}
			setMessage({ type: 'error', text: 'Missing redirect response.' })
		} catch {
			setMessage({
				type: 'error',
				text: 'Network error. Please try again.',
			})
		} finally {
			submittingDecision = null
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
			resetCompleted = false
			allowClientReset = false
			info = null
			status = 'loading'
			const queryError = readQueryError()
			message = queryError ? { type: 'error', text: queryError } : null
			activeInfoRequestId += 1
			void loadInfo(activeInfoRequestId)
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
		const showResetClientCard = allowClientReset && !resetCompleted
		const showAuthorizeForm = !resetCompleted
		const actionsDisabled =
			status !== 'ready' || Boolean(submittingDecision) || isSessionLoading
		const resetClientDisabled =
			Boolean(submittingDecision) || isSessionLoading || !isLoggedIn
		const formReady = status === 'ready' && !isSessionLoading
		const authorizeLabel = submittingDecision
			? 'Submitting...'
			: isLoggedIn
				? 'Approve connection'
				: 'Authorize'
		const resetClientLabel =
			submittingDecision === 'reset-client'
				? 'Deleting stored client...'
				: 'Delete stored client'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(headerCss)}>
					<span mix={css(eyebrowCss)}>Kody secure connection</span>
					<h2 mix={css(pageTitleCss)}>Authorize access</h2>
					<p mix={css(pageDescriptionCss)}>
						{clientLabel} wants to access your kody account.
					</p>
				</header>
				<section mix={css(cardCss)}>
					<p mix={css(sectionTitleCss)}>Requested scopes</p>
					<p mix={css(descriptionCss)}>{scopeLabel}</p>
				</section>
				{isSessionLoading ? (
					<p mix={css(descriptionCss)}>Checking your session...</p>
				) : null}
				{isLoggedIn ? (
					<section mix={css(insetCardCss)}>
						<p
							mix={css({
								margin: 0,
								fontWeight: typography.fontWeight.medium,
								color: colors.text,
							})}
						>
							Signed in as {sessionEmail}
						</p>
						<p mix={css(descriptionCss)}>
							{resetCompleted
								? 'Start the connection again from your client to continue with this account.'
								: 'Approve to continue with this account.'}
						</p>
					</section>
				) : null}
				{status === 'loading' ? (
					<p mix={css(descriptionCss)}>Loading authorization details...</p>
				) : null}
				{message ? (
					<p
						role={message.type === 'error' ? 'alert' : undefined}
						mix={css(getAlertCardCss(message.type))}
					>
						{message.text}
					</p>
				) : null}
				{showResetClientCard ? (
					<section mix={css(cardCss)}>
						<p mix={css(sectionTitleCss)}>Reset stored connection</p>
						<p mix={css(descriptionCss)}>
							Delete this trusted client&apos;s saved registration and grants,
							then start the connection again from the client to create a fresh
							record.
						</p>
						{isLoggedIn ? (
							<button
								type="button"
								disabled={resetClientDisabled}
								mix={[
									on('click', () => submitDecision('reset-client')),
									css(dangerButtonCss),
								]}
							>
								{resetClientLabel}
							</button>
						) : isSessionReady ? (
							<p mix={css(descriptionCss)}>
								Sign in first, then delete the stored client record.
							</p>
						) : null}
					</section>
				) : null}
				{showAuthorizeForm ? (
					<form
						mix={[
							css({
								...cardCss,
								opacity: formReady ? 1 : 0.7,
							}),
							on('submit', handleSubmit),
						]}
					>
						{!isLoggedIn && isSessionReady ? (
							<>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Email</span>
									<input
										type="email"
										name="email"
										required
										autoComplete="email"
										placeholder="you@example.com"
										disabled={actionsDisabled}
										mix={css(inputCss)}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Password</span>
									<input
										type="password"
										name="password"
										required
										autoComplete="current-password"
										placeholder="Enter your password"
										disabled={actionsDisabled}
										mix={css(inputCss)}
									/>
								</label>
							</>
						) : null}
						<div
							mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
						>
							<button
								type="submit"
								disabled={actionsDisabled}
								mix={css(primaryButtonCss)}
							>
								{authorizeLabel}
							</button>
							<button
								type="button"
								disabled={actionsDisabled}
								mix={[
									on('click', () => submitDecision('deny')),
									css(secondaryButtonCss),
								]}
							>
								Deny
							</button>
						</div>
					</form>
				) : null}
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
				</a>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

const headerCss = pageHeaderCss
const eyebrowCss = pageEyebrowCss
const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const dangerButtonCss = getDangerButtonCss({
	size: 'lg',
	weight: 'semibold',
})
