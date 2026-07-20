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
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import { OnboardingDiyCard } from '#client/routes/onboarding-diy-card.tsx'
import { OnboardingMcpClientTabs } from '#client/routes/onboarding-mcp-client-tabs.tsx'
import { OnboardingStarterCard } from '#client/routes/onboarding-starter-card.tsx'
import {
	onboardingPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
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
	loggedIn: boolean
	mcpServerUrl: string
	setupPrompt: string
	discoveryPrompt: string
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
	featuredListings: Array<OnboardingFeaturedListing>
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
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load onboarding.')
	}
	if (payload.loggedIn && !payload.emailVerified) {
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
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) return null
	return payload
}

export function OnboardingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let message: string | null = null
	let loggedIn = false
	let mcpServerUrl = ''
	let setupPrompt = ''
	let discoveryPrompt = ''
	let hasMcpClient = false
	let featuredListings: Array<OnboardingFeaturedListing> = []
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		loggedIn = payload.loggedIn
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		discoveryPrompt = payload.discoveryPrompt
		hasMcpClient = payload.hasMcpClient
		featuredListings = payload.featuredListings ?? []
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
			const payload = await readJson<OnboardingPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load onboarding.')
			}
			if (payload.loggedIn && !payload.emailVerified) {
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
		if (routeData.loggedIn && !routeData.emailVerified) {
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

						<section
							id="discovery"
							mix={css(cardCss)}
							data-testid="onboarding-discovery"
						>
							<h2 mix={css(cardTitleCss)}>
								Not sure what you&apos;d use Kody for?
							</h2>
							<p mix={css(descriptionCss)}>
								Paste this into any AI agent that can fetch a URL or search the
								web — ChatGPT, Claude, or whatever you already use. It has the
								agent read Kody&apos;s docs, interview you, and suggest concrete
								automations. No account or setup needed yet.
							</p>
							<pre mix={css(codeBlockCss)}>{discoveryPrompt}</pre>
							<CopyTextButton
								value={discoveryPrompt}
								idleLabel="Copy discovery prompt"
								variant="secondary"
							/>
						</section>

						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>1. Add Kody as an MCP server</h2>
							<p mix={css(descriptionCss)}>
								Pick your MCP client below for host-specific setup. When the
								agent connects, it starts an OAuth flow — sign in to Kody if
								needed, approve the request, and the agent receives a token
								scoped to your account.
							</p>
							<OnboardingMcpClientTabs mcpServerUrl={mcpServerUrl} />
						</section>

						{renderByokExplainer({ image: 'handoff' })}

						<section
							mix={css(cardCss)}
							data-testid="onboarding-starter-packages"
						>
							<h2 mix={css(cardTitleCss)}>2. Install a starter package</h2>
							<p mix={css(descriptionCss)}>
								{featuredListings.length > 0
									? 'These packages were reviewed by an admin and support one-click install here. After install, use Copy prompt so your agent can finish any remaining setup — or pick Choose your own adventure to explore with your agent instead.'
									: 'No featured starters are available right now. Copy the Choose your own adventure prompt to explore with your agent, or browse community packages.'}
							</p>
							<ul mix={css(starterGridCss)}>
								{featuredListings.map((listing) => (
									<OnboardingStarterCard
										key={listing.id}
										listing={listing}
										loggedIn={loggedIn}
									/>
								))}
								<OnboardingDiyCard setupPrompt={setupPrompt} />
							</ul>
							<p mix={css({ margin: 0 })}>
								<a href="/community" mix={css(primaryLinkCss)}>
									Browse all community packages
								</a>
							</p>
						</section>

						<p mix={css({ margin: 0 })}>
							{loggedIn ? (
								<>
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
								</>
							) : (
								<>
									<a href="/signup" mix={css(primaryLinkCss)}>
										Sign up
									</a>
									{' · '}
									<a href="/login" mix={css(mutedLinkCss)}>
										Log in
									</a>
								</>
							)}
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

const starterGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(10.5rem, 1fr))',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
	[mq.mobile]: {
		gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))',
		gap: spacing.sm,
	},
}
