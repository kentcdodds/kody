import { type Handle, css } from 'remix/ui'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
} from '#client/routes/account-management-components.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import {
	onboardingPath,
	resolveOnboardingLoginPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	insetCardCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

export type OnboardingPayload = {
	ok: true
	mcpServerUrl: string
	setupPrompt: string
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
}

export const onboardingApiPath = '/onboarding.json'
export { onboardingPath }

function isOnboardingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === onboardingPath
}

function readOnboardingRedirectTo(handle: Handle) {
	return normalizeRedirectTo(
		new URLSearchParams(readRouterSearch(handle)).get('redirectTo'),
	)
}

export async function onboardingRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect(resolveOnboardingLoginPath(redirectTo))
	}
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load onboarding.')
	}
	if (!payload.emailVerified) {
		return routeLoaderRedirect(
			resolveOnboardingPendingVerificationPath(redirectTo),
		)
	}
	return { onboarding: payload }
}

export async function fetchOnboardingPayload(signal?: AbortSignal) {
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return null
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) return null
	return payload
}

export function OnboardingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let message: string | null = null
	let mcpServerUrl = ''
	let setupPrompt = ''
	let hasMcpClient = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		hasMcpClient = payload.hasMcpClient
		status = 'ready'
		message = null
	}

	async function loadOnboarding(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		const redirectTo = readOnboardingRedirectTo(handle)
		try {
			const response = await fetch(onboardingApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign(resolveOnboardingLoginPath(redirectTo))
				return
			}
			const payload = await readJson<OnboardingPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load onboarding.')
			}
			if (!payload.emailVerified) {
				window.location.assign(
					resolveOnboardingPendingVerificationPath(redirectTo),
				)
				return
			}
			applyPayload(payload)
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load onboarding.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isOnboardingPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (!routeData) return false
		if (!routeData.emailVerified) {
			window.location.assign(
				resolveOnboardingPendingVerificationPath(
					readOnboardingRedirectTo(handle),
				),
			)
			return true
		}
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
			handle.queueTask(loadOnboarding)
		}

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountManagementHeader
					title="Get started with Kody"
					description="Connect any MCP-capable AI agent to your Kody account, then ask it to help you set things up."
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading onboarding…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<>
						{hasMcpClient ? (
							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>You are connected</h2>
								<p mix={css(descriptionCss)}>
									At least one AI agent has already authorized access to this
									account. You can still use the steps below to connect another
									host or re-run setup with your agent.
								</p>
							</section>
						) : null}

						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>1. Add Kody as an MCP server</h2>
							<p mix={css(descriptionCss)}>
								In Cursor, Claude Desktop, or any other AI agent that supports
								MCP, add a remote MCP server pointed at this URL:
							</p>
							<pre mix={css(codeBlockCss)}>{mcpServerUrl}</pre>
							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
								})}
							>
								<CopyTextButton
									value={mcpServerUrl}
									idleLabel="Copy MCP URL"
									variant="primary"
								/>
							</div>
							<p mix={css(descriptionCss)}>
								When your agent connects, it starts an OAuth flow. Sign in to
								Kody if needed, approve the request, and the agent receives a
								token scoped to your account.
							</p>
						</section>

						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>2. Ask your agent to help set up</h2>
							<p mix={css(descriptionCss)}>
								After the connection succeeds, paste this prompt into your
								agent. It asks the agent to explain what Kody can do and help
								you configure the basics.
							</p>
							<pre mix={css(codeBlockCss)}>{setupPrompt}</pre>
							<CopyTextButton
								value={setupPrompt}
								idleLabel="Copy prompt"
								variant="secondary"
							/>
						</section>

						{renderByokExplainer({ image: 'handoff' })}

						<p mix={css({ margin: 0 })}>
							<a href="/account" mix={css(mutedLinkCss)}>
								Back to account
							</a>
							{' · '}
							<a href="/account/secrets" mix={css(primaryLinkCss)}>
								Secrets
							</a>
							{' · '}
							<a href="/account/integrations" mix={css(primaryLinkCss)}>
								Integrations
							</a>
						</p>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

const codeBlockCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}
