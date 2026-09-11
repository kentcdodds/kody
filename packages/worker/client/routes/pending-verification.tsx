import { type Handle, css } from 'remix/ui'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
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
import { resolvePostVerificationRedirect } from '#client/routes/pending-verification-path.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { fetchSessionInfo } from '#client/session.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import { layoutMaxWidths } from '#universal/styles/style-primitives.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import {
	acceptedEmailVerificationDelivery,
	type EmailVerificationDelivery,
} from '#universal/email-verification-delivery.ts'
import { type PendingVerificationLoaderData } from '#universal/loader-data.ts'
import { buildAuthLink } from '#client/auth-links.ts'

const pendingVerificationImageSrc = '/images/kody-envelope.png'
const pendingVerificationImageAlt =
	'Kody holding a sealed envelope with a green wax K stamp'

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
		pendingVerification: {
			ok: true,
			email: session.email,
			emailVerificationDelivery: session.emailVerificationDelivery,
		},
	}
}

export function PendingVerificationRoute(handle: Handle) {
	let email = ''
	let emailVerificationDelivery: EmailVerificationDelivery | null = null
	let message: string | null = null
	let resendStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'
	let deliveryPollScheduled = false
	/** Payload last applied to the closure state above. */
	let appliedPayload: PendingVerificationLoaderData | null = null
	let appliedError: Error | null = null
	const pendingData = createRouteData({
		key: 'pendingVerification',
		async load(_href, signal) {
			const session = await fetchSessionInfo(signal)
			if (!session) {
				return routeDataRedirect(buildLoginRedirectForPending(handle))
			}
			if (session.emailVerified) {
				return routeDataRedirect(
					resolvePostVerificationRedirect(readPendingRedirectTo(handle)),
				)
			}
			return {
				ok: true as const,
				email: session.email,
				emailVerificationDelivery: session.emailVerificationDelivery,
			}
		},
	})

	function applyPayload(payload: PendingVerificationLoaderData) {
		email = payload.email
		emailVerificationDelivery = payload.emailVerificationDelivery ?? null
		message = null
	}

	async function pollVerificationDelivery() {
		deliveryPollScheduled = false
		try {
			const session = await fetchSessionInfo()
			if (!session) {
				handle.update()
				return
			}
			if (session.emailVerified) {
				window.location.assign(
					resolvePostVerificationRedirect(readPendingRedirectTo(handle)),
				)
				return
			}
			emailVerificationDelivery = session.emailVerificationDelivery
			deliveryPollScheduled = false
			handle.update()
		} catch {
			deliveryPollScheduled = false
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
			if (result.ok) {
				emailVerificationDelivery = acceptedEmailVerificationDelivery()
			}
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

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = pendingData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'
		if (
			status === 'ready' &&
			!deliveryPollScheduled &&
			typeof document !== 'undefined'
		) {
			deliveryPollScheduled = true
			handle.queueTask(() => {
				window.setTimeout(() => {
					void pollVerificationDelivery()
				}, 15_000)
			})
		}

		return (
			<AccountManagementShell
				maxWidth={layoutMaxWidths.content}
				busy={pending && appliedPayload !== null}
			>
				<div
					data-testid="pending-verification-page"
					mix={css(pendingVerificationLayoutCss)}
				>
					<img
						src={pendingVerificationImageSrc}
						alt={pendingVerificationImageAlt}
						width={686}
						height={1305}
						mix={css(pendingVerificationImageCss)}
					/>
					<div mix={css(pendingVerificationCopyCss)}>
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
									delivery: emailVerificationDelivery,
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
					</div>
				</div>
			</AccountManagementShell>
		)
	}
}

const pendingVerificationLayoutCss = {
	display: 'grid',
	gridTemplateColumns: 'auto minmax(0, 1fr)',
	gap: spacing.xl,
	alignItems: 'center',
	[mq.mobile]: {
		gridTemplateColumns: 'minmax(0, 1fr)',
		justifyItems: 'center',
		gap: spacing.lg,
	},
}

const pendingVerificationImageCss = {
	width: 'min(16rem, 36vw)',
	maxHeight: 'min(28rem, 70vh)',
	height: 'auto',
	objectFit: 'contain' as const,
	display: 'block',
	[mq.mobile]: {
		width: 'min(12rem, 58vw)',
		maxHeight: 'min(18rem, 38vh)',
	},
}

const pendingVerificationCopyCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
	width: '100%',
}
