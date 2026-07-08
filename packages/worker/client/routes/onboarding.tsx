import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
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
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
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
	needsOnboarding: boolean
}

export const onboardingApiPath = '/onboarding.json'
export const onboardingPath = '/onboarding'

function isOnboardingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === onboardingPath
}

export async function onboardingRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load onboarding.')
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
	let urlCopyState: 'idle' | 'copied' | 'error' = 'idle'
	let promptCopyState: 'idle' | 'copied' | 'error' = 'idle'
	const loadLatch = createRouteLoadLatch()
	let urlCopyResetTimer: ReturnType<typeof setTimeout> | null = null
	let promptCopyResetTimer: ReturnType<typeof setTimeout> | null = null

	function applyPayload(payload: OnboardingPayload) {
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		hasMcpClient = payload.hasMcpClient
		status = 'ready'
		message = null
	}

	async function loadOnboarding(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(onboardingApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login?redirectTo=%2Fonboarding')
				return
			}
			const payload = await readJson<OnboardingPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load onboarding.')
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
		applyPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	async function copyValue(value: string, kind: 'url' | 'prompt') {
		try {
			await writeClipboardText(value)
			if (kind === 'url') {
				urlCopyState = 'copied'
				if (urlCopyResetTimer) clearTimeout(urlCopyResetTimer)
				urlCopyResetTimer = setTimeout(() => {
					urlCopyState = 'idle'
					handle.update()
				}, 2000)
			} else {
				promptCopyState = 'copied'
				if (promptCopyResetTimer) clearTimeout(promptCopyResetTimer)
				promptCopyResetTimer = setTimeout(() => {
					promptCopyState = 'idle'
					handle.update()
				}, 2000)
			}
		} catch {
			if (kind === 'url') urlCopyState = 'error'
			else promptCopyState = 'error'
		}
		handle.update()
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

		const primaryButtonCss = getPrimaryButtonCss()
		const secondaryButtonCss = getSecondaryButtonCss()

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
								<button
									type="button"
									mix={[
										css(primaryButtonCss),
										on('click', () => void copyValue(mcpServerUrl, 'url')),
									]}
								>
									{urlCopyState === 'copied'
										? 'Copied'
										: urlCopyState === 'error'
											? 'Copy failed'
											: 'Copy MCP URL'}
								</button>
							</div>
							<p mix={css(descriptionCss)}>
								When your agent connects, it starts an OAuth flow. Sign in to
								Kody if needed, approve the request, and the agent receives a
								token scoped to your account.
							</p>
							<p mix={css(descriptionCss)}>
								Verify your account email first if you have not already — MCP
								access stays disabled until the email is verified.
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
							<button
								type="button"
								mix={[
									css(secondaryButtonCss),
									on('click', () => void copyValue(setupPrompt, 'prompt')),
								]}
							>
								{promptCopyState === 'copied'
									? 'Copied'
									: promptCopyState === 'error'
										? 'Copy failed'
										: 'Copy prompt'}
							</button>
						</section>

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
