import { type Handle, css } from 'remix/component'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { readAppSession } from '#client/app-session-context.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileResponseFieldName,
} from '#client/public-form-protection.ts'
import {
	startOauthAuthorizePasskeySignIn,
	startOauthAuthorizeProviderSignIn,
} from '#client/routes/oauth-authorize-sign-in.tsx'
import { renderOauthAuthorizeConsent } from '#client/routes/oauth-authorize-consent.tsx'
import {
	fetchPublicAuthConfig,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'

export { oauthAuthorizeRouteLoader } from '#client/routes/oauth-authorize-loader.ts'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'
import {
	oauthAuthorizeAccessLead,
	oauthAuthorizeHeaderCss,
	oauthAuthorizePageCss,
	type OAuthAuthorizeStatus,
} from '#client/routes/oauth-authorize-chrome.ts'
import {
	oauthAuthorizeActionsDisabled,
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentFormAttrs,
	oauthAuthorizeOrgField,
	readOAuthAuthorizeConsentOrgs,
	readOAuthAuthorizeSelectedOrgSlug,
	type OAuthAuthorizeConsentOrg,
} from '#client/routes/oauth-authorize-form.ts'
import { renderOauthAuthorizeGrant } from '#client/routes/oauth-authorize-org-picker.tsx'
import { resolveAuthorizeSession } from '#client/routes/oauth-authorize-session.ts'
import {
	fetchSessionInfo,
	getSessionDisplayName,
	queueSessionRefresh,
	type SessionInfo,
} from '#client/session.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	insetCardCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageTitleCss,
} from '#universal/styles/style-primitives.ts'

type OAuthAuthorizeInfo = {
	client: { id: string; name: string }
	scopes: Array<string>
	emailVerified: boolean | null
	requireCredentials: boolean
	orgs: Array<OAuthAuthorizeConsentOrg>
	selectedOrgSlug: string | null
}

type OAuthAuthorizeMessage = { type: 'error' | 'info'; text: string }
type OAuthAuthorizeDecision = 'approve' | 'deny' | 'reset-client'

function getSearchParams(handle: Handle) {
	return new URLSearchParams(readRouterSearch(handle))
}

function isOAuthAuthorizePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/oauth/authorize'
}

export function OAuthAuthorizeRoute(handle: Handle) {
	let info: OAuthAuthorizeInfo | null = null
	let status: OAuthAuthorizeStatus = 'idle'
	let message: OAuthAuthorizeMessage | null = null
	let submittingDecision: OAuthAuthorizeDecision | null = null
	let lastSearch = ''
	let turnstileSiteKey: string | null | undefined
	let authProviders: Array<AuthProviderInfo> = []
	let authProvidersReady = false
	let signInStatus: 'idle' | 'submitting' = 'idle'
	let sessionOverride: SessionInfo | null | undefined
	let sessionOverrideBaseline: SessionInfo | null | undefined
	let resetCompleted = false
	let allowClientReset = false
	let activeInfoRequestId = 0
	let resendStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'
	// Stay false through SSR and the first client render so hydrate matches
	// the disabled form. Flip after queueTask, once submit handlers are bound.
	let consentInteractive = false
	// Tracks the picker choice so the grant heading matches the submitted org.
	let pickedOrgSlug: string | null | undefined

	function setMessage(next: OAuthAuthorizeMessage | null) {
		message = next
		handle.update()
	}

	function setSignInError(text: string) {
		// Social/passkey start spends the Turnstile token; refresh before retry
		// (same pattern as /login setSubmitError).
		resetTurnstileWidgets()
		signInStatus = 'idle'
		setMessage({ type: 'error', text })
	}

	function readDisplayedOrgSlug() {
		if (pickedOrgSlug !== undefined) return pickedOrgSlug
		return info?.selectedOrgSlug ?? null
	}

	function readQueryError() {
		const params = getSearchParams(handle)
		const description = params.get('error_description')
		if (description) return description
		const error = params.get('error')
		return error ? `Authorization error: ${error}` : null
	}

	async function loadProtectionConfig(signal: AbortSignal) {
		if (turnstileSiteKey !== undefined && authProvidersReady) return
		const config = await fetchPublicAuthConfig(signal)
		if (signal.aborted) return
		if (turnstileSiteKey === undefined) {
			turnstileSiteKey = config?.turnstileSiteKey ?? null
		}
		if (!authProvidersReady) {
			authProviders = config?.providers ?? []
			authProvidersReady = true
		}
		handle.update()
	}

	async function handleProviderSignIn(providerId: string) {
		if (signInStatus === 'submitting') return
		signInStatus = 'submitting'
		handle.update()
		try {
			const errorMessage = await startOauthAuthorizeProviderSignIn({
				providerId,
				redirectTo: readOAuthResumeTarget(),
			})
			if (errorMessage) {
				setSignInError(errorMessage)
			}
		} catch {
			setSignInError('Network error. Please try again.')
		}
	}

	async function handlePasskeySignIn() {
		if (signInStatus === 'submitting') return
		signInStatus = 'submitting'
		handle.update()
		try {
			const result = await startOauthAuthorizePasskeySignIn({
				redirectTo: readOAuthResumeTarget(),
			})
			if (!result.ok) {
				if (result.error === null) {
					signInStatus = 'idle'
					handle.update()
					return
				}
				setSignInError(result.error)
			}
		} catch {
			setSignInError('Network error. Please try again.')
		}
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
				requireCredentials: payload.requireCredentials === true,
				orgs: readOAuthAuthorizeConsentOrgs(payload.orgs),
				selectedOrgSlug: readOAuthAuthorizeSelectedOrgSlug(
					payload.selectedOrgSlug,
				),
			}
			pickedOrgSlug = undefined
			status = 'ready'
			allowClientReset = false
			message = null
			handle.update()
		} catch {
			if (requestId !== activeInfoRequestId) return
			info = null
			pickedOrgSlug = undefined
			status = 'error'
			allowClientReset = false
			message = {
				type: 'error',
				text: 'Unable to load authorization details.',
			}
			handle.update()
		}
	}

	function consumeAuthProvidersLoader(currentHref: string) {
		if (authProvidersReady) return
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'authProviders',
			currentHref,
		)
		if (!routeData) return
		authProviders = routeData.providers
		turnstileSiteKey = routeData.turnstileSiteKey
		authProvidersReady = true
	}

	function applyRouteLoaderData(currentHref: string) {
		if (!isOAuthAuthorizePath(currentHref)) return false
		consumeAuthProvidersLoader(currentHref)
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
				requireCredentials: routeData.requireCredentials === true,
				orgs: routeData.orgs,
				selectedOrgSlug: routeData.selectedOrgSlug,
			}
			pickedOrgSlug = undefined
			status = 'ready'
			allowClientReset = false
			message = null
		} else {
			info = null
			pickedOrgSlug = undefined
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
		// Preserve the full authorize query for the auth round-trip; strip
		// prompt=login only after credentials succeed (post-auth landing).
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
			if (result.ok) {
				await refreshSession()
			}
		} catch {
			resendTone = 'error'
			resendMessage = 'Unable to resend the verification email.'
		} finally {
			resendStatus = 'idle'
			handle.update()
		}
	}

	async function refreshSession() {
		const appSession = readAppSession(handle)
		const nextSession = await fetchSessionInfo()
		sessionOverrideBaseline = appSession.session
		sessionOverride = nextSession
		queueSessionRefresh()
		return nextSession
	}

	function readEffectiveSession() {
		const resolved = resolveAuthorizeSession({
			shared: readAppSession(handle),
			override: sessionOverride,
			overrideBaseline: sessionOverrideBaseline,
		})
		if (resolved.clearOverride) {
			sessionOverride = undefined
			sessionOverrideBaseline = undefined
		}
		return {
			session: resolved.session,
			sessionStatus: resolved.status,
		}
	}

	async function handleContinueAfterVerify() {
		const nextSession = await refreshSession()
		activeInfoRequestId += 1
		const requestId = activeInfoRequestId
		await loadInfo(requestId)
		if (nextSession?.emailVerified) {
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
				const org = String(formData.get('org') ?? '').trim()
				if (org) body.set('org', org)
				const email = String(formData.get('email') ?? '').trim()
				const password = String(formData.get('password') ?? '')
				if (email || password) {
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
					const protection = readPublicFormProtection(formData, form)
					body.set(honeypotFieldName, protection[honeypotFieldName])
					body.set(
						turnstileResponseFieldName,
						protection[turnstileResponseFieldName],
					)
				}
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
					await refreshSession()
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
		await submitDecision('approve', event.currentTarget)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const currentSearch = readRouterSearch(handle)
		// Consume before scheduling /auth/providers.json. An SSR embed or SPA
		// preload is the provider list. The fetch runs only on a miss.
		const appliedRouteData = applyRouteLoaderData(currentHref)
		if (typeof document !== 'undefined' && turnstileSiteKey === undefined) {
			handle.queueTask(loadProtectionConfig)
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey ?? null))
		}
		const { session, sessionStatus } = readEffectiveSession()
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
		const clientLabel = info?.client?.name ?? 'Unknown client'
		const scopes = info?.scopes ?? []
		const sessionEmail = session?.email ?? ''
		const sessionDisplayName = getSessionDisplayName(session)
		const isSessionReady = sessionStatus === 'ready'
		const isSessionLoading =
			sessionStatus === 'loading' || sessionStatus === 'idle'
		const requireCredentials = info?.requireCredentials === true
		const isLoggedIn =
			isSessionReady && Boolean(sessionEmail) && !requireCredentials
		const emailVerified = resolveAuthorizeEmailVerified({
			isSessionReady,
			sessionEmailVerified: session?.emailVerified,
			infoEmailVerified: info?.emailVerified,
		})
		const needsEmailVerification = isLoggedIn && !emailVerified
		const showResetClientCard = allowClientReset && !resetCompleted
		const showAuthorizeForm =
			!resetCompleted && !needsEmailVerification && status !== 'error'
		if (typeof document !== 'undefined' && !consentInteractive) {
			handle.queueTask(() => {
				if (consentInteractive) return
				consentInteractive = true
				handle.update()
			})
		}
		const hydrated = consentInteractive
		const consentForm = oauthAuthorizeConsentFormAttrs(currentHref)
		const displayedOrgSlug = readDisplayedOrgSlug()
		const orgField = oauthAuthorizeOrgField({
			orgs: info?.orgs ?? [],
			selectedOrgSlug: displayedOrgSlug,
			signedIn: isLoggedIn,
		})
		const actionsDisabled =
			oauthAuthorizeActionsDisabled({
				hydrated,
				statusReady: status === 'ready',
				submitting: Boolean(submittingDecision),
				sessionLoading: isSessionLoading,
				needsEmailVerification,
			}) || orgField.kind === 'missing'
		const resetClientDisabled =
			Boolean(submittingDecision) || isSessionLoading || !isLoggedIn
		const formReady = hydrated && status === 'ready' && !isSessionLoading
		const accessLead = oauthAuthorizeAccessLead(status, clientLabel)
		const authorizeLabel = submittingDecision
			? 'Submitting...'
			: isLoggedIn
				? 'Approve connection'
				: 'Authorize'
		const approveAriaLabel = oauthAuthorizeApproveAriaLabel({
			hydrated,
			label: authorizeLabel,
		})
		const resetClientLabel =
			submittingDecision === 'reset-client'
				? 'Resetting this connection...'
				: 'Reset this connection'

		return (
			<section mix={css(oauthAuthorizePageCss)}>
				<header mix={css(oauthAuthorizeHeaderCss)}>
					<span mix={css(pageEyebrowCss)}>Kody secure connection</span>
					<h1 mix={css(pageTitleCss)}>Authorize access</h1>
					{accessLead ? (
						<p mix={css(pageDescriptionCss)}>{accessLead}</p>
					) : null}
				</header>
				{status === 'ready'
					? renderOauthAuthorizeGrant({
							clientLabel,
							scopes,
							selectedOrgSlug: displayedOrgSlug,
						})
					: null}
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
							delivery: session?.emailVerificationDelivery ?? null,
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
				{renderOauthAuthorizeConsent({
					needsEmailVerification,
					resetCompleted,
					hydrated,
					submittingDecision,
					sessionLoading: isSessionLoading,
					message,
					showResetClientCard,
					isLoggedIn,
					isSessionReady,
					resetClientDisabled,
					resetClientLabel,
					showAuthorizeForm,
					consentForm,
					formReady,
					orgs: info?.orgs ?? [],
					displayedOrgSlug,
					onSelectedOrgSlugChange: (slug) => {
						pickedOrgSlug = slug
						handle.update()
					},
					onSubmit: handleSubmit,
					onDecision: (decision) => {
						void submitDecision(decision)
					},
					actionsDisabled,
					signInSubmitting: signInStatus === 'submitting',
					turnstileSiteKey,
					authProviders,
					resumeTarget: sessionEmail ? null : readOAuthResumeTarget(),
					onProviderClick: (providerId) => {
						void handleProviderSignIn(providerId)
					},
					onPasskeyClick: () => {
						void handlePasskeySignIn()
					},
					approveAriaLabel,
					authorizeLabel,
				})}
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
				</a>
			</section>
		)
	}
}
