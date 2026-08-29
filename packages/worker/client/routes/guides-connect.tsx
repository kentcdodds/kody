import { type Handle, css } from 'remix/ui'
import { type GuidesConnectLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	guideListCss,
	guidesHeadCss,
	guidesPageCss,
	groupHeadingCss,
	listStatusCss,
	renderGuideItem,
} from '#client/routes/guides.tsx'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Connection guides index: verified per-provider walkthroughs. Linked from
 * `/guides` as a secondary path so fundamentals stay first on the main index.
 */

const guidesConnectApiPath = routes.guidesConnectApi.href()

function isGuidesConnectPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname === routes.guidesConnect.href()
	)
}

export async function guidesConnectRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(guidesConnectApiPath, {
		headers: { Accept: 'application/json' },
		signal,
	})
	const payload = await readJson<GuidesConnectLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load connection guides.')
	}
	return { guidesConnect: payload }
}

export function GuidesConnectRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let guides: GuidesConnectLoaderData['guides'] = []
	const loadLatch = createRouteLoadLatch()

	async function loadGuides(signal: AbortSignal) {
		try {
			const response = await fetch(guidesConnectApiPath, {
				headers: { Accept: 'application/json' },
				signal,
			})
			const payload = await readJson<GuidesConnectLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load connection guides.')
			}
			guides = payload.guides
			status = 'ready'
			handle.update()
		} catch {
			if (signal.aborted) return
			status = 'error'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isGuidesConnectPath(currentHref)) {
			return <section mix={css(guidesPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'guidesConnect',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			guides = routeData.guides
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			const loadAttempt = loadLatch.getPendingAttempt()
			handle.queueTask(async (signal) => {
				try {
					await loadGuides(signal)
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					loadLatch.markFailed(currentHref)
				}
			})
		}

		return (
			<section mix={css(guidesPageCss)}>
				<header mix={css(guidesHeadCss)}>
					<p mix={css(connectBackCss)} data-rise style={{ '--rise': '0' }}>
						<a href={routes.guides.href()}>← Work with Kody</a>
					</p>
					<h1 data-rise style={{ '--rise': '1' }}>
						Connect a provider
					</h1>
					<p data-rise style={{ '--rise': '2' }}>
						How to connect Discord, GitHub, Google, Notion, Origin, Salesforce,
						Slack, or Spotify to Kody. Each walkthrough is verified against the
						real console — append <code>.md</code> to hand it to your agent.
					</p>
					<p data-rise style={{ '--rise': '3' }} mix={css(connectHintCss)}>
						New to Kody? Start with{' '}
						<a href={routes.guideDetail.href({ slug: 'how-kody-works' })}>
							How Kody works
						</a>{' '}
						or the full <a href={routes.guides.href()}>Work with Kody</a> index.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(listStatusCss)}>Loading connection guides…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(listStatusCss)}>Unable to load connection guides.</p>
				) : null}
				{status === 'ready' ? (
					<>
						<section>
							<h2 mix={css(groupHeadingCss)}>Provider guides</h2>
							<ul mix={css(guideListCss)}>
								{guides.map((guide, index) => renderGuideItem(guide, index))}
							</ul>
						</section>
						<section>
							<h2 mix={css(groupHeadingCss)}>Related</h2>
							<ul mix={css(guideListCss)}>
								<li data-rise style={{ '--rise': '2' }}>
									<a
										href={routes.guideDetail.href({
											slug: 'local-mcp-tunnels',
										})}
										mix={css(relatedLinkCss)}
									>
										<strong>Connect a home MCP server</strong>
										<span mix={css(relatedSummaryCss)}>
											Run a local MCP process (vault, CLI, or home devices) and
											connect it to Kody.
										</span>
									</a>
								</li>
							</ul>
						</section>
					</>
				) : null}
			</section>
		)
	}
}

const connectBackCss = {
	margin: '0 0 0.85rem',
	fontSize: '0.92rem',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
}

const connectHintCss = {
	margin: '0.85rem 0 0',
	fontSize: '0.95rem',
	color: colors.textMuted,
	maxWidth: '58ch',
}

const relatedLinkCss = {
	display: 'block',
	padding: '1.05rem 0',
	textDecoration: 'none',
	color: 'inherit',
	'& strong': {
		fontSize: '1.08rem',
		fontWeight: 700,
		letterSpacing: '-0.012em',
		color: colors.primaryText,
	},
}

const relatedSummaryCss = {
	display: 'block',
	marginTop: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	maxWidth: '62ch',
}
