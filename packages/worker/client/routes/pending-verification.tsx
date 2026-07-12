import { type Handle, css } from 'remix/ui'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { type AccountStatus } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
} from '#client/routes/account-management-components.tsx'
import {
	buildPendingVerificationPath,
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import { resolveContinueVerificationFeedback } from '#client/routes/pending-verification-continue.ts'
import {
	pendingVerificationPath,
	resolvePostVerificationRedirect,
} from '#client/routes/pending-verification-path.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { fetchSessionInfo } from '#client/session.ts'
import { colors } from '#client/styles/tokens.ts'
import { layoutMaxWidths } from '#client/styles/style-primitives.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import { type PendingVerificationLoaderData } from '#app/loader-data.ts'
import { buildAuthLink } from '#client/auth-links.ts'

function isPendingVerificationPath(href: string) {
	return new URL(href, 'http://localhost').pathname === pendingVerificationPath
}

function readPendingRedirectTo(handle: Handle) {
	return normalizeRedirectTo(
		new URLSearchParams(readRouterSearch(handle)).get('redirectTo'),
	)
}

function buildLoginRedirectForPending(handle: Handle) {
	const pendingHref = buildPendingVerificationPath(
		readPendingRedirectTo(handle),
	)
	return buildAuthLink('/login', pendingHref)
}

export async function pendingVerificationRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const session = await fetchSessionInfo(signal)
	if (!session) {
		const pendingHref = buildPendingVerificationPath(
			normalizeRedirectTo(url.searchParams.get('redirectTo')),
		)
		return routeLoaderRedirect(buildAuthLink('/login', pendingHref))
	}
	if (session.emailVerified) {
		return routeLoaderRedirect(
			resolvePostVerificationRedirect(url.searchParams.get('redirectTo')),
		)
	}
	return {
		pendingVerification: { ok: true, email: session.email },
	}
}

export function PendingVerificationRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let message: string | null = null
	let resendStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: PendingVerificationLoaderData) {
		email = payload.email
		status = 'ready'
		message = null
	}

	async function loadPending(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const session = await fetchSessionInfo(signal)
			if (signal.aborted) return
			if (!session) {
				window.location.assign(buildLoginRedirectForPending(handle))
				return
			}
			if (session.emailVerified) {
				window.location.assign(
					resolvePostVerificationRedirect(readPendingRedirectTo(handle)),
				)
				return
			}
			applyPayload({ ok: true, email: session.email })
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load verification status.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function handleResend() {
		resendStatus = 'sending'
		resendMessage = null
		resendTone = 'info'
		handle.update()
		try {
			const result = await requestResendVerification(
				readPendingRedirectTo(handle),
			)
			if (!result.ok && result.unauthorized) {
				window.location.assign(buildLoginRedirectForPending(handle))
				return
			}
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

	async function handleContinue() {
		try {
			const session = await fetchSessionInfo()
			const feedback = resolveContinueVerificationFeedback(session)
			if (feedback.status === 'verified') {
				window.location.assign(
					resolvePostVerificationRedirect(readPendingRedirectTo(handle)),
				)
				return
			}
			resendTone = feedback.tone
			resendMessage = feedback.message
		} catch {
			resendTone = 'error'
			resendMessage = 'Unable to check verification status. Try again.'
		}
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!isPendingVerificationPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'pendingVerification',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadPending)
		}

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountManagementHeader
					title="Check your email"
					description="Your Kody account is ready. Verify your email before connecting an AI agent or using MCP."
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading verification…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready'
					? renderEmailVerificationPrompt({
							email,
							description:
								'We sent a verification link to your inbox. MCP access stays locked until you verify. Keep this browser signed in so you can resend the email or continue once the link works.',
							resendStatus,
							resendMessage,
							resendTone,
							onResend: () => {
								void handleResend()
							},
							continueLabel: "I've verified - continue",
							onContinue: () => {
								void handleContinue()
							},
							secondaryHref: '/account',
							secondaryLabel: 'Account settings',
						})
					: null}
			</AccountManagementShell>
		)
	}
}
