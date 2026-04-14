import { type Handle } from 'remix/component'
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
import { canResetStoredClientForMessage } from '@kody-internal/shared/oauth-messages.ts'

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

	function readResetErrorDescription() {
		const queryError = readQueryError()
		if (canResetStoredClientForMessage(queryError)) {
			return queryError
		}
		const messageText = message?.text
		return canResetStoredClientForMessage(messageText) ? messageText : null
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
			let submitUrl = window.location.href
			if (decision === 'reset-client') {
				const resetErrorDescription = readResetErrorDescription()
				if (resetErrorDescription) {
					const url = new URL(submitUrl)
					if (!url.searchParams.get('error_description')) {
						url.searchParams.set('error_description', resetErrorDescription)
						submitUrl = url.toString()
					}
				}
			}
			const response = await fetch(submitUrl, {
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
			void loadInfo()
		}
		if (sessionStatus === 'idle') {
			void loadSession()
		}

		const clientLabel = info?.client?.name ?? 'Unknown client'
		const scopes = info?.scopes ?? []
		const scopeLabel =
			scopes.length > 0 ? scopes.join(', ') : 'No scopes requested.'
		const resetErrorDescription = readResetErrorDescription()
		const sessionEmail = session?.email ?? ''
		const isSessionReady = sessionStatus === 'ready'
		const isSessionLoading =
			sessionStatus === 'loading' || sessionStatus === 'idle'
		const isLoggedIn = isSessionReady && Boolean(sessionEmail)
		const showResetClientCard = Boolean(resetErrorDescription) && !resetCompleted
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
			<section css={pageCss}>
				<header css={headerCss}>
					<span css={eyebrowCss}>Kody secure connection</span>
					<h2 css={pageTitleCss}>Authorize access</h2>
					<p css={pageDescriptionCss}>
						{clientLabel} wants to access your kody account.
					</p>
				</header>
				<section css={cardCss}>
					<p css={sectionTitleCss}>Requested scopes</p>
					<p css={descriptionCss}>{scopeLabel}</p>
				</section>
				{isSessionLoading ? (
					<p css={descriptionCss}>Checking your session...</p>
				) : null}
				{isLoggedIn ? (
					<section css={insetCardCss}>
						<p
							css={{
								margin: 0,
								fontWeight: typography.fontWeight.medium,
								color: colors.text,
							}}
						>
							Signed in as {sessionEmail}
						</p>
						<p css={descriptionCss}>
							{resetCompleted
								? 'Start the connection again from your client to continue with this account.'
								: 'Approve to continue with this account.'}
						</p>
					</section>
				) : null}
				{status === 'loading' ? (
					<p css={descriptionCss}>Loading authorization details...</p>
				) : null}
				{message ? (
					<p
						css={getAlertCardCss(message.type)}
						role={message.type === 'error' ? 'alert' : undefined}
					>
						{message.text}
					</p>
				) : null}
				{showResetClientCard ? (
					<section css={cardCss}>
						<p css={sectionTitleCss}>Reset stored connection</p>
						<p css={descriptionCss}>
							Delete this trusted client&apos;s saved registration and grants,
							then start the connection again from the client to create a fresh
							record.
						</p>
						{isLoggedIn ? (
							<button
								type="button"
								disabled={resetClientDisabled}
								on={{ click: () => submitDecision('reset-client') }}
								css={dangerButtonCss}
							>
								{resetClientLabel}
							</button>
						) : isSessionReady ? (
							<p css={descriptionCss}>
								Sign in first, then delete the stored client record.
							</p>
						) : null}
					</section>
				) : null}
				{showAuthorizeForm ? (
					<form
						css={{
							...cardCss,
							opacity: formReady ? 1 : 0.7,
						}}
						on={{ submit: handleSubmit }}
					>
						{!isLoggedIn && isSessionReady ? (
							<>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Email</span>
									<input
										type="email"
										name="email"
										required
										autoComplete="email"
										placeholder="you@example.com"
										disabled={actionsDisabled}
										css={inputCss}
									/>
								</label>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Password</span>
									<input
										type="password"
										name="password"
										required
										autoComplete="current-password"
										placeholder="Enter your password"
										disabled={actionsDisabled}
										css={inputCss}
									/>
								</label>
							</>
						) : null}
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="submit"
								disabled={actionsDisabled}
								css={primaryButtonCss}
							>
								{authorizeLabel}
							</button>
							<button
								type="button"
								disabled={actionsDisabled}
								on={{ click: () => submitDecision('deny') }}
								css={secondaryButtonCss}
							>
								Deny
							</button>
						</div>
					</form>
				) : null}
				<a href="/" css={mutedLinkCss}>
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
