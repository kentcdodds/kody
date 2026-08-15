import { type Handle, css } from 'remix/ui'
import {
	type GuidesLoaderData,
	type GuideSummaryLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { hoverMq, pageHeadCss } from '#universal/styles/style-primitives.ts'

/**
 * Guides index: the same editorial column as the blog, grouped into
 * platform guides (Kody primitives) and provider guides (verified
 * per-provider connect walkthroughs). Everything comes from the server's
 * bundled guide catalog — nothing is hardcoded here.
 */

const guidesApiPath = routes.guidesApi.href()

function isGuidesIndexPath(href: string) {
	return new URL(href, 'http://localhost').pathname === routes.guides.href()
}

export async function guidesRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(guidesApiPath, {
		headers: { Accept: 'application/json' },
		signal,
	})
	const payload = await readJson<GuidesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load guides.')
	}
	return { guides: payload }
}

export function formatLastVerified(lastVerified: string): string {
	const [year, month] = lastVerified.split('-')
	const monthIndex = Number(month) - 1
	const monthNames = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	]
	const name = monthNames[monthIndex]
	if (!name || !year) return lastVerified
	return `${name} ${year}`
}

export function GuidesRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let guides: GuidesLoaderData['guides'] = []
	const loadLatch = createRouteLoadLatch()

	async function loadGuides(signal: AbortSignal) {
		// Do not call handle.update() before the first await — see blog.tsx.
		try {
			const response = await fetch(guidesApiPath, {
				headers: { Accept: 'application/json' },
				signal,
			})
			const payload = await readJson<GuidesLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load guides.')
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
		if (!isGuidesIndexPath(currentHref)) {
			return <section mix={css(guidesPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'guides', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			guides = routeData.guides
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			handle.queueTask(async (signal) => {
				try {
					await loadGuides(signal)
					if (signal.aborted) return
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					if (signal.aborted) return
					loadLatch.markFailed(currentHref)
				}
			})
		}

		const providerGuides = guides.filter(
			(guide) => guide.category === 'provider',
		)
		const platformGuides = guides.filter(
			(guide) => guide.category === 'platform',
		)

		return (
			<section mix={css(guidesPageCss)}>
				<header mix={css(guidesHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Guides for you <em>and your agent</em>
					</h1>
					<p data-rise style={{ '--rise': '1' }}>
						Connect walkthroughs and Kody workflows, verified against the real
						consoles. Every guide is also plain markdown — append{' '}
						<code>.md</code> to any URL and hand it to your agent.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(listStatusCss)}>Loading guides…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(listStatusCss)}>Unable to load guides.</p>
				) : null}
				{status === 'ready' ? (
					<>
						{providerGuides.length > 0 ? (
							<section>
								<h2 mix={css(groupHeadingCss)}>Connect a provider</h2>
								<ul mix={css(guideListCss)}>
									{providerGuides.map((guide, index) =>
										renderGuideItem(guide, index),
									)}
								</ul>
							</section>
						) : null}
						<section>
							<h2 mix={css(groupHeadingCss)}>Work with Kody</h2>
							<ul mix={css(guideListCss)}>
								{platformGuides.map((guide, index) =>
									renderGuideItem(guide, index),
								)}
							</ul>
						</section>
					</>
				) : null}
			</section>
		)
	}
}

function renderGuideItem(guide: GuideSummaryLoaderData, index: number) {
	return (
		<li key={guide.slug} data-rise style={{ '--rise': String(index + 2) }}>
			<a
				href={routes.guideDetail.href({ slug: guide.slug })}
				mix={css(guideLinkCss)}
			>
				<strong>{guide.title}</strong>
				{guide.lastVerified ? (
					<span mix={css(guideMetaCss)}>
						Verified {formatLastVerified(guide.lastVerified)}
					</span>
				) : null}
				<span mix={css(guideSummaryCss)}>{guide.summary}</span>
			</a>
		</li>
	)
}

/* ---------- styles (blog index rhythm on the same 46rem measure) ---------- */

const guidesPageCss = {
	maxWidth: '46rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

const guidesHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'& h1': {
		...pageHeadCss['& h1'],
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
	},
	'& > p': {
		...pageHeadCss['& > p'],
		margin: '1rem 0 0',
	},
}

const groupHeadingCss = {
	margin: 'clamp(2.4rem, 5vw, 3.2rem) 0 0',
	fontSize: '1.05rem',
	fontWeight: 720,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const listStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const guideListCss = {
	listStyle: 'none',
	margin: '0.6rem 0 0',
	padding: 0,
	'& li + li': {
		borderTop: `1px solid ${colors.border}`,
	},
}

const guideLinkCss = {
	display: 'block',
	padding: '1.05rem 0',
	textDecoration: 'none',
	color: 'inherit',
	'& strong': {
		fontSize: '1.08rem',
		fontWeight: 700,
		letterSpacing: '-0.012em',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'&:hover strong': {
			color: colors.primaryText,
		},
	},
}

const guideMetaCss = {
	marginLeft: '0.6rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
}

const guideSummaryCss = {
	display: 'block',
	marginTop: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	maxWidth: '62ch',
}
