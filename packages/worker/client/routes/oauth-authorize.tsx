import { type Handle, css } from 'remix/ui'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'
import {
	fetchSessionInfo,
	getSessionDisplayName,
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
	emailVerified: boolean | null
}

type OAuthAuthorizeStatus = 'idle' | 'loading' | 'ready' | 'error'
type OAuthAuthorizeMessage = { type: 'error' | 'info'; text: string }
type OAuthAuthorizeDecision = 'approve' | 'deny' | 'reset-client'

function getSearchParams(handle: Handle) {
	return new URLSearchParams(readRouterSearch(handle))
}

function isOAuthAuthorizePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/oauth/authorize'
}

export async function oauthAuthorizeRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`/oauth/authorize-info${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = await response.json().catch(() => null)
	if (!response.ok || !payload?.ok) {
		const errorText =
			typeof payload?.error === 'string'
				? payload.error
				: 'Unable to load authorization details.'
		return {
			oauthAuthorize: {
				ok: false,
				error: errorText,
				allowClientReset: payload?.allowClientReset === true,
				code: typeof payload?.code === 'string' ? payload.code : undefined,
			},
		}
	}
	return {
		oauthAuthorize: {
			ok: true,
			client: payload.client,
			scopes: payload.scopes,
			emailVerified:
				typeof payload.emailVerified === 'boolean'
					? payload.emailVerified
					: null,
		},
	}
}

export function OAuthAuthorizeRoute(handle: Handle) {
	let info: OAuthAuthorizeInfo | null = null
	let status: OAuthAuthorizeStatus = 'idle'
	let message: OAuthAuthorizeMessage | null = null
	let submittingDecision: OAuthAuthorizeDecision | null = null
	let lastSearch = ''
	let turnstileSiteKey: string | null | undefined
	let session: SessionInfo | null = null
	let sessionStatus: SessionStatus = 'idle'
	let resetCompleted = false
	let allowClientReset = false
	let activeInfoRequestId = 0
	let resendStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'

	function setMessage(next: OAuthAuthorizeMessage | null) {
		message = next
		handle.update()
	}

	function readQueryError() {
		const params = getSearchParams(handle)
		const description = params.get('error_description')
		if (description) return description
		const error = params.get('error')
		return error ? `Authorization error: ${error}` : null
	}

	async function loadProtectionConfig(signal: AbortSignal) {
		if (turnstileSiteKey !== undefined) return
		const config = await fetchPublicAuthConfig(signal)
		if (signal.aborted) return
		turnstileSiteKey = config?.turnstileSiteKey ?? null
		handle.update()
	}

	async function loadInfo(requestId: number) {
		try {
			const query = readRouterSearch(handle)
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
				emailVerified:
					typeof payload.emailVerified === 'boolean'
						? payload.emailVerified
						: null,
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

	function applyRouteLoaderData(currentHref: string) {
		if (!isOAuthAuthorizePath(currentHref)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'oauthAuthorize',
			currentHref,
		)
		if (!routeData) return false
		// Invalidate any in-flight fallback fetch so a stale response cannot
		// overwrite the fresher consumed payload.
		activeInfoRequestId += 1
		resetCompleted = false
		if (routeData.ok) {
			info = {
				client: routeData.client,
				scopes: routeData.scopes,
				emailVerified:
					typeof routeData.emailVerified === 'boolean'
						? routeData.emailVerified
						: null,
			}
			status = 'ready'
			allowClientReset = false
			message = null
		} else {
			info = null
			status = 'error'
			allowClientReset = routeData.allowClientReset
			message = { type: 'error', text: routeData.error }
		}
		return true
	}

	function readOAuthResumeTarget() {
		const currentUrl = new URL(
			readCurrentRouterHref(handle),
			'http://localhost',
		)
		return normalizeRedirectTo(`${currentUrl.pathname}${currentUrl.search}`)
	}

	async function handleResendVerification() {
		resendStatus = 'sending'
		resendMessage = null
		resendTone = 'info'
		handle.update()
		try {
			const result = await requestResendVerification(readOAuthResumeTarget())
			resendTone = result.ok ? 'info' : 'error'
			resendMessage = result.message
		} catch {
			resendTone = 'error'
			resendMessage = 'Unable to resend the verification email.'
		} finally {
			resendStatus = 'idle'
			handle.update()
		}
	}

	async function handleContinueAfterVerify() {
		session = await fetchSessionInfo()
		sessionStatus = 'ready'
		activeInfoRequestId += 1
		const requestId = activeInfoRequestId
		await loadInfo(requestId)
		if (session?.emailVerified) {
			resendTone = 'info'
			resendMessage = 'Email verified. You can approve the connection now.'
		} else {
			resendTone = 'info'
			resendMessage =
				'Still waiting on verification. Keep this page open, finish verification in another tab, then continue.'
		}
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
				const protection = readPublicFormProtection(formData)
				body.set('website', protection.website)
				body.set('turnstileToken', protection.turnstileToken)
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
				if (payload?.code === 'email_verification_required') {
					session = await fetchSessionInfo()
					sessionStatus = 'ready'
				}
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
		if (typeof document !== 'undefined' && turnstileSiteKey === undefined) {
			handle.queueTask(loadProtectionConfig)
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey ?? null))
		}
		const currentHref = readCurrentRouterHref(handle)
		const currentSearch = readRouterSearch(handle)
		// Consume on every render so same-path preload-then-commit refreshes
		// (unchanged search) still apply fresh loader data.
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// search change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		if (appliedRouteData) {
			lastSearch = currentSearch
		} else if (
			status === 'idle' ||
			currentSearch !== lastSearch ||
			needsStaleRefresh
		) {
			lastSearch = currentSearch
			resetCompleted = false
			const queryError = readQueryError()
			allowClientReset = false
			info = null
			status = 'loading'
			message = queryError ? { type: 'error', text: queryError } : null
			activeInfoRequestId += 1
			const requestId = activeInfoRequestId
			if (typeof document !== 'undefined') {
				handle.queueTask(() => loadInfo(requestId))
			}
		}
		if (sessionStatus === 'idle' && typeof document !== 'undefined') {
			handle.queueTask(() => loadSession())
		}

		const clientLabel = info?.client?.name ?? 'Unknown client'
		const scopes = info?.scopes ?? []
		const scopeLabel =
			scopes.length > 0 ? scopes.join(', ') : 'No scopes requested.'
		const sessionEmail = session?.email ?? ''
		const sessionDisplayName = getSessionDisplayName(session)
		const isSessionReady = sessionStatus === 'ready'
		const isSessionLoading =
			sessionStatus === 'loading' || sessionStatus === 'idle'
		const isLoggedIn = isSessionReady && Boolean(sessionEmail)
		const emailVerified = resolveAuthorizeEmailVerified({
			isSessionReady,
			sessionEmailVerified: session?.emailVerified,
			infoEmailVerified: info?.emailVerified,
		})
		const needsEmailVerification = isLoggedIn && !emailVerified
		const showResetClientCard = allowClientReset && !resetCompleted
		const showAuthorizeForm = !resetCompleted && !needsEmailVerification
		const actionsDisabled =
			status !== 'ready' ||
			Boolean(submittingDecision) ||
			isSessionLoading ||
			needsEmailVerification
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
					<h1 mix={css(pageTitleCss)}>Authorize access</h1>
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
							Signed in as {sessionDisplayName}
						</p>
						<p mix={css(descriptionCss)}>
							{resetCompleted
								? 'Start the connection again from your client to continue with this account.'
								: needsEmailVerification
									? 'Verify your email before approving MCP access. Keep this page open so the original OAuth request is preserved.'
									: 'Approve to continue with this account.'}
						</p>
					</section>
				) : null}
				{needsEmailVerification
					? renderEmailVerificationPrompt({
							email: sessionEmail,
							description:
								'MCP authorization cannot finish until this account email is verified. Resend the link here if needed. Keep this page open, verify in another tab, then continue without restarting the host connection.',
							resendStatus,
							resendMessage,
							resendTone,
							onResend: () => {
								void handleResendVerification()
							},
							continueLabel: "I've verified - continue",
							onContinue: () => {
								void handleContinueAfterVerify()
							},
						})
					: null}
				{needsEmailVerification && !resetCompleted ? (
					<div mix={css({ marginBottom: spacing.md })}>
						<button
							type="button"
							disabled={Boolean(submittingDecision) || isSessionLoading}
							mix={[
								on('click', () => submitDecision('deny')),
								css(secondaryButtonCss),
							]}
						>
							Deny
						</button>
					</div>
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
						<input
							type="text"
							name={honeypotFieldName}
							tabIndex={-1}
							autoComplete="off"
							aria-hidden="true"
							mix={css(honeypotCss)}
						/>
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
						{!isLoggedIn && turnstileSiteKey ? (
							<div class={turnstileWidgetClassName}></div>
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

const honeypotCss = {
	position: 'absolute' as const,
	left: '-10000px',
	width: '1px',
	height: '1px',
	overflow: 'hidden' as const,
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
