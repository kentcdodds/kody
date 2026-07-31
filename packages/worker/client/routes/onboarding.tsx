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
import {
	fetchOnboardingPayload,
	onboardingApiPath,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
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

	// Users typically keep this page open while their MCP client runs the
	// OAuth flow, so poll the same JSON endpoint until a grant shows up and
	// collapse the completed steps without requiring a manual refresh.
	let pollIntervalId: ReturnType<typeof setInterval> | undefined
	let pollInFlight = false

	async function pollForMcpConnection() {
		if (hasMcpClient) {
			clearInterval(pollIntervalId)
			return
		}
		if (pollInFlight || status !== 'ready' || !loggedIn) return
		if (document.hidden) return
		if (!isOnboardingPath(readCurrentRouterHref(handle))) return
		pollInFlight = true
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload?.hasMcpClient) return
			applyPayload(payload)
			handle.update()
		} catch {
			// Transient poll failures are fine; the next tick retries.
		} finally {
			pollInFlight = false
		}
	}

	if (typeof document !== 'undefined') {
		pollIntervalId = setInterval(pollForMcpConnection, 5000)
		handle.signal.addEventListener('abort', () => clearInterval(pollIntervalId))
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
									account, so the first steps below are collapsed. Open them any
									time to connect another host or re-run setup with your agent.
								</p>
							</section>
						) : null}

						{renderOnboardingStep({
							title: '1. Not sure what you\u2019d use Kody for?',
							collapsed: hasMcpClient,
							id: 'discovery',
							testId: 'onboarding-discovery',
							children: (
								<>
									<p mix={css(descriptionCss)}>
										Paste this into any AI agent that can fetch a URL or search
										the web — ChatGPT, Claude, Grok, or whatever you already
										use. It has the agent read Kody&apos;s docs, interview you,
										and suggest concrete automations. No account or setup needed
										yet.
									</p>
									<pre mix={css(codeBlockCss)}>{discoveryPrompt}</pre>
									<CopyTextButton
										value={discoveryPrompt}
										idleLabel="Copy discovery prompt"
										variant="secondary"
									/>
								</>
							),
						})}

						{renderOnboardingStep({
							title: '2. Add Kody as an MCP server',
							collapsed: hasMcpClient,
							children: (
								<>
									<p mix={css(descriptionCss)}>
										Pick your MCP client below for host-specific setup. When the
										agent connects, it starts an OAuth flow — sign in to Kody if
										needed, approve the request, and the agent receives a token
										scoped to your account.
									</p>
									<OnboardingMcpClientTabs mcpServerUrl={mcpServerUrl} />
								</>
							),
						})}

						<section
							mix={css(cardCss)}
							data-testid="onboarding-starter-packages"
						>
							<h2 mix={css(cardTitleCss)}>3. Install a starter package</h2>
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

						{renderByokExplainer({ image: 'handoff' })}

						{loggedIn ? null : (
							<p mix={css({ margin: 0 })}>
								<a href="/signup" mix={css(primaryLinkCss)}>
									Sign up
								</a>
								{' · '}
								<a href="/login" mix={css(mutedLinkCss)}>
									Log in
								</a>
							</p>
						)}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

type OnboardingStepSlot = any

/**
 * Renders an onboarding step as an open card, or — once an MCP client is
 * already connected — as a collapsed `<details>` card the user can reopen to
 * redo the step (e.g. connect another host).
 */
function renderOnboardingStep(input: {
	title: string
	collapsed: boolean
	id?: string
	testId?: string
	children: OnboardingStepSlot
}) {
	if (!input.collapsed) {
		return (
			<section id={input.id} mix={css(cardCss)} data-testid={input.testId}>
				<h2 mix={css(cardTitleCss)}>{input.title}</h2>
				{input.children}
			</section>
		)
	}
	return (
		<details id={input.id} mix={css(cardCss)} data-testid={input.testId}>
			<summary mix={css(collapsedStepSummaryCss)}>
				<h2 mix={css(collapsedStepTitleCss)}>{input.title}</h2>
				<span mix={css(collapsedStepHintCss)}>Done — open to revisit</span>
			</summary>
			{input.children}
		</details>
	)
}

const collapsedStepSummaryCss = {
	cursor: 'pointer',
	'&::marker': {
		color: colors.textMuted,
	},
}

const collapsedStepTitleCss = {
	...cardTitleCss,
	display: 'inline' as const,
}

const collapsedStepHintCss = {
	marginLeft: spacing.sm,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
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
