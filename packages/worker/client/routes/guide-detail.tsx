import { type Handle, type RemixNode, css } from 'remix/ui'
import { type GuideDetailLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { formatLastVerified } from '#client/routes/guides.tsx'
import { renderHowKodyWorksWalkthrough } from '#client/routes/how-kody-works-walkthrough.tsx'
import { renderGoogleOauthWalkthrough } from '#client/routes/google-oauth-walkthrough.tsx'
import { colors } from '#universal/styles/tokens.ts'
import {
	articleMeasure,
	pageGutter,
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'

const interactiveGuideRenderers: Readonly<
	Record<string, () => ReturnType<typeof renderHowKodyWorksWalkthrough>>
> = {
	'how-kody-works': renderHowKodyWorksWalkthrough,
	'google-oauth': renderGoogleOauthWalkthrough,
}

/**
 * Guide detail: back link → guide head (title, verified month) → `.prose`
 * body rendered from the server's bundled markdown catalog with the
 * first-party link policy (guides link into `/connect/oauth` and
 * `/account/secrets/new`) and copyable code blocks. Interactive slugs
 * (how-kody-works, google-oauth) swap the prose body for a transcript
 * walkthrough. A quiet foot links the raw markdown twin for agents
 * (`rmx-document` so the SPA does not intercept `/guides/:slug.md`).
 */

export function getGuideSlugFromPathname(pathname: string) {
	const prefix = `${routes.guides.href()}/`
	if (!pathname.startsWith(prefix)) return null
	let slug: string
	try {
		slug = decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ''))
	} catch {
		return null
	}
	// Dots mark non-page paths under /guides (.json / .md twins); real guide
	// slugs are kebab-case and never contain one.
	if (!slug || slug.includes('/') || slug.includes('.')) return null
	return slug
}

function isGuideDetailPath(href: string) {
	return (
		getGuideSlugFromPathname(new URL(href, 'http://localhost').pathname) !==
		null
	)
}

export async function guideDetailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const slug = getGuideSlugFromPathname(url.pathname)
	if (!slug) {
		// Non-page paths under /guides (.json / .md) are served by the worker
		// as raw documents; leave the SPA instead of rendering a missing page.
		return routeLoaderRedirect(`${url.pathname}${url.search}`)
	}

	const response = await fetch(routes.guideDetailApi.href({ slug }), {
		headers: { Accept: 'application/json' },
		signal,
	})
	if (response.status === 404) {
		throw new Error('Guide not found.')
	}
	const payload = await readJson<GuideDetailLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load guide.')
	}
	return { guideDetail: payload }
}

/**
 * Guide bodies keep their authored `# Title` for GitHub and raw-markdown
 * readers; the page owns the h1 from frontmatter, so drop the body's
 * leading h1 to avoid rendering the title twice.
 */
export function stripLeadingH1(body: string): string {
	return body.replace(/^# [^\n]*\n+/, '')
}

export function GuideDetailRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' | 'not-found' = 'loading'
	let guide: GuideDetailLoaderData | null = null
	/** Slug that `guide` / `status` currently describe. */
	let loadedSlug: string | null = null
	const loadLatch = createRouteLoadLatch()

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered body per markdown string (same policy as MarkdownView).
	let renderedForBody: string | null = null
	let renderedBody: Array<RemixNode> = []

	function renderGuideBody(body: string) {
		if (renderedForBody !== body) {
			renderedForBody = body
			renderedBody = renderMarkdownNodes(stripLeadingH1(body), {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
				linkPolicy: 'first-party',
				copyCodeBlocks: true,
			})
		}
		return renderedBody
	}

	async function loadGuide(slug: string, signal: AbortSignal) {
		// Do not call handle.update() before the first await — see blog.tsx.
		try {
			const response = await fetch(routes.guideDetailApi.href({ slug }), {
				headers: { Accept: 'application/json' },
				signal,
			})
			if (signal.aborted) return
			if (response.status === 404) {
				guide = null
				status = 'not-found'
				loadedSlug = slug
				handle.update()
				return
			}
			const payload = await readJson<GuideDetailLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load guide.')
			}
			guide = payload
			status = 'ready'
			loadedSlug = slug
			handle.update()
		} catch {
			if (signal.aborted) return
			status = 'error'
			loadedSlug = slug
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const slug = getGuideSlugFromPathname(readRouterPathname(handle))
		if (!slug || !isGuideDetailPath(currentHref)) {
			return <article mix={css(guidePageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'guideDetail',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			guide = routeData
			status = 'ready'
			loadedSlug = routeData.slug
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
			const loadAttempt = loadLatch.getPendingAttempt()
			handle.queueTask(async (signal) => {
				try {
					await loadGuide(slug, signal)
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					if (status === 'ready' || status === 'not-found') {
						loadLatch.markLoaded(currentHref)
					} else {
						loadLatch.markFailed(currentHref)
					}
				} catch {
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					loadLatch.markFailed(currentHref)
				}
			})
		}

		// Never show another guide's content after a fast navigation.
		const contentMatchesSlug = loadedSlug === slug
		const showNotFound = status === 'not-found' && contentMatchesSlug
		const showError = status === 'error' && contentMatchesSlug
		const showReady = status === 'ready' && guide !== null && contentMatchesSlug
		const showLoading = !showNotFound && !showError && !showReady

		if (showNotFound) {
			return (
				<article mix={css(guidePageCss)}>
					<a href={routes.guides.href()} mix={css(guideBackCss)}>
						← All guides
					</a>
					<header mix={css(guideHeadCss)}>
						<h1>Guide not found</h1>
						<p mix={css(guideMetaCss)}>
							That guide does not exist or may have been removed.
						</p>
					</header>
				</article>
			)
		}

		return (
			<article mix={css(guidePageCss)}>
				<a
					data-rise
					style={{ '--rise': '0' }}
					href={routes.guides.href()}
					mix={css(guideBackCss)}
				>
					← All guides
				</a>

				{showLoading ? (
					<p mix={css(guideStatusCss)} role="status">
						Loading guide…
					</p>
				) : null}
				{showError ? (
					<p mix={css(guideStatusCss)} role="status">
						Unable to load this guide.
					</p>
				) : null}
				{showReady && guide ? (
					<>
						<header mix={css(guideHeadCss)}>
							<h1 data-rise style={{ '--rise': '1' }}>
								{guide.title}
							</h1>
							<p data-rise style={{ '--rise': '2' }} mix={css(guideMetaCss)}>
								{guide.lastVerified
									? `Verified against the ${guide.provider ?? 'provider'} console, ${formatLastVerified(guide.lastVerified)}`
									: 'Official Kody guide'}
							</p>
						</header>

						{interactiveGuideRenderers[guide.slug]?.() ?? (
							<div mix={css(proseCss)}>{renderGuideBody(guide.body)}</div>
						)}

						<footer mix={css(guideFootCss)}>
							<p>
								Working with an agent? This guide is also plain markdown at{' '}
								<a
									href={routes.guideDetailMarkdown.href({ slug: guide.slug })}
									rmx-document
								>
									/guides/{guide.slug}.md
								</a>
								, or load it over MCP with{' '}
								<code>{`coding_guide_get({ guide: '${guide.id}' })`}</code>.
							</p>
						</footer>
					</>
				) : null}
			</article>
		)
	}
}

/* ---------- styles (blog post rhythm on the 43rem measure) ---------- */

const guidePageCss = {
	maxWidth: articleMeasure,
	minWidth: 0,
	marginInline: 'auto',
	padding: `clamp(2.5rem, 6vw, 4rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const guideBackCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

const guideHeadCss = {
	position: 'relative' as const,
	isolation: 'isolate' as const,
	marginTop: '1.8rem',
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-90% -30% -250%',
		background: `radial-gradient(ellipse 46% 55% at 70% 30%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p': {
		marginTop: '0.9rem',
	},
}

const guideMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const guideStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const guideFootCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.95rem',
	},
	'& a': {
		color: colors.primaryText,
	},
}
