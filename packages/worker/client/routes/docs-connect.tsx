import { type Handle, css } from 'remix/ui'
import { type DocsConnectLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	docListCss,
	docsGroupHeadingCss,
	docsListStatusCss,
	renderDocListItem,
	renderDocsShell,
} from '#client/routes/docs-shell.tsx'
import { colors } from '#universal/styles/tokens.ts'
import {
	articleMeasure,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'

/**
 * `/docs/connect`: the "Connect a provider" section index — verified
 * per-provider walkthroughs with their last-verified month, inside the docs
 * shell so the sidebar stays put.
 */

const docsConnectApiPath = routes.docsConnectApi.href()

function isDocsConnectPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname === routes.docsConnect.href()
	)
}

export async function docsConnectRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(docsConnectApiPath, {
		headers: { Accept: 'application/json' },
		signal,
	})
	const payload = await readJson<DocsConnectLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load connection docs.')
	}
	return { docsConnect: payload }
}

export function DocsConnectRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let guides: DocsConnectLoaderData['guides'] = []
	const loadLatch = createRouteLoadLatch()

	async function loadGuides(signal: AbortSignal) {
		try {
			const response = await fetch(docsConnectApiPath, {
				headers: { Accept: 'application/json' },
				signal,
			})
			const payload = await readJson<DocsConnectLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load connection docs.')
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
		if (!isDocsConnectPath(currentHref)) {
			return <section mix={css(connectPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'docsConnect',
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

		return renderDocsShell({
			current: 'connect',
			children: (
				<section mix={css(connectPageCss)}>
					<header mix={css(connectHeadCss)}>
						<p data-rise style={{ '--rise': '0' }} mix={css(connectEyebrowCss)}>
							Docs
						</p>
						<h1 data-rise style={{ '--rise': '1' }}>
							Connect a provider
						</h1>
						<p data-rise style={{ '--rise': '2' }}>
							How to connect Discord, GitHub, Google, Notion, Origin,
							Salesforce, Slack, or Spotify to Kody. Each walkthrough is
							verified against the real console — append <code>.md</code> to
							hand it to your agent.
						</p>
						<p data-rise style={{ '--rise': '3' }} mix={css(connectHintCss)}>
							Provider not listed? Follow{' '}
							<a href={docHref('integration-bootstrap')}>
								Integration bootstrap
							</a>{' '}
							and <a href={docHref('oauth')}>OAuth (bring your own app)</a>, or
							store a key with{' '}
							<a href={docHref('secret-backed-integration')}>
								Secret-backed integrations
							</a>
							.
						</p>
					</header>

					{status === 'loading' ? (
						<p mix={css(docsListStatusCss)}>Loading connection docs…</p>
					) : null}
					{status === 'error' ? (
						<p mix={css(docsListStatusCss)}>Unable to load connection docs.</p>
					) : null}
					{status === 'ready' ? (
						<>
							<section>
								<h2 mix={css(docsGroupHeadingCss)}>Providers</h2>
								<ul mix={css(docListCss)}>
									{guides.map((guide, index) =>
										renderDocListItem(guide, index),
									)}
								</ul>
							</section>
							<section>
								<h2 mix={css(docsGroupHeadingCss)}>Related</h2>
								<ul mix={css(docListCss)}>
									<li data-rise style={{ '--rise': '2' }}>
										<a
											href={docHref('local-mcp-tunnels')}
											mix={css(relatedLinkCss)}
										>
											<strong>Connect a home MCP server</strong>
											<span mix={css(relatedSummaryCss)}>
												Run a local MCP process (vault, CLI, or home devices)
												and connect it to Kody.
											</span>
										</a>
									</li>
									<li data-rise style={{ '--rise': '3' }}>
										<a
											href={docHref('locked-mcp-server')}
											mix={css(relatedLinkCss)}
										>
											<strong>Lock an MCP server to a package</strong>
											<span mix={css(relatedSummaryCss)}>
												Keep a connected server's tools off execute and other
												packages.
											</span>
										</a>
									</li>
								</ul>
							</section>
						</>
					) : null}
				</section>
			),
		})
	}
}

const connectPageCss = {
	maxWidth: articleMeasure,
	minWidth: 0,
	padding: 'clamp(2.5rem, 6vw, 4rem) 0 clamp(4rem, 8vw, 6.5rem)',
}

const connectHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'& h1': {
		...pageHeadCss['& h1'],
		margin: '0.6rem 0 0',
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
	},
	'& > p': {
		...pageHeadCss['& > p'],
		margin: '1rem 0 0',
	},
	'& a': {
		color: colors.primaryText,
		textDecoration: 'underline',
		textUnderlineOffset: '0.15em',
	},
}

const connectEyebrowCss = {
	fontSize: '0.8rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const connectHintCss = {
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
