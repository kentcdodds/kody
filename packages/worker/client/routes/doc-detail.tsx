import { type Handle, type RemixNode, css } from 'remix/ui'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type DocDetailLoaderData } from '#universal/loader-data.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import { routes } from '#universal/routes.ts'
import {
	docHref,
	docsIntroSlug,
	findDocsNavSection,
	isReservedDocsIndexSlug,
	resolveLegacyDocSlug,
} from '#universal/docs-nav.ts'
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
import {
	formatLastVerified,
	renderDocsPager,
	renderDocsShell,
} from '#client/routes/docs-shell.tsx'
import { HowKodyWorksWalkthrough } from '#client/routes/how-kody-works-walkthrough.tsx'
import { renderGoogleOauthWalkthrough } from '#client/routes/google-oauth-walkthrough.tsx'
import { colors, radius } from '#universal/styles/tokens.ts'
import {
	articleMeasure,
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'

const interactiveDocRenderers: Readonly<
	Record<
		string,
		(
			highlights?: Record<string, HighlightedCode>,
			hosts?: WalkthroughHostPick,
		) => RemixNode
	>
> = {
	'how-kody-works': (highlights, hosts) => (
		<HowKodyWorksWalkthrough highlights={highlights} hosts={hosts} />
	),
	'google-oauth': (highlights) => renderGoogleOauthWalkthrough(highlights),
}

/**
 * Doc page for `/docs` (the introduction) and `/docs/:slug`: docs shell
 * (sidebar) → section eyebrow → title + meta → `.prose` body rendered from
 * the server's bundled markdown catalog with the first-party link policy
 * (docs link into `/connect/oauth` and `/account/secrets/new`) and copyable
 * code blocks → previous/next → a quiet foot with the raw markdown twin for
 * agents (`data-rmx-document` so the SPA does not intercept
 * `/docs/:slug.md`). Interactive slugs (how-kody-works, google-oauth) swap
 * the prose body for a transcript walkthrough.
 */

/**
 * Slug for a docs page path, or null when the path is not a doc page.
 * `/docs` itself is the introduction.
 */
function getDocSlugFromPathname(pathname: string): string | null {
	const root = routes.docs.href()
	if (pathname === root || pathname === `${root}/`) return docsIntroSlug
	const prefix = `${root}/`
	if (!pathname.startsWith(prefix)) return null
	let slug: string
	try {
		slug = decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ''))
	} catch {
		return null
	}
	// Dots mark non-page paths under /docs (.json / .md twins, llms.txt);
	// real doc slugs are kebab-case and never contain one. Reserved index
	// segments (`connect`) are dedicated routes, not doc details.
	if (
		!slug ||
		slug.includes('/') ||
		slug.includes('.') ||
		isReservedDocsIndexSlug(slug)
	) {
		return null
	}
	return slug
}

function isDocDetailPath(href: string) {
	return (
		getDocSlugFromPathname(new URL(href, 'http://localhost').pathname) !== null
	)
}

async function loadDocDetail(
	slug: string,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(routes.docDetailApi.href({ slug }), {
		headers: { Accept: 'application/json' },
		signal,
	})
	if (response.status === 404) {
		throw new Error('Doc not found.')
	}
	const payload = await readJson<DocDetailLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load doc.')
	}
	return { docDetail: payload }
}

/** `/docs` — the introduction article. */
export async function docsIntroRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	return loadDocDetail(docsIntroSlug, signal)
}

export async function docDetailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const slug = getDocSlugFromPathname(url.pathname)
	if (!slug) {
		// Non-page paths under /docs (.json / .md / llms.txt) are served by
		// the worker as raw documents; leave the SPA instead of rendering a
		// missing page.
		return routeLoaderRedirect(`${url.pathname}${url.search}`)
	}
	// The worker 308s these; mirror it so an in-app click lands on the
	// canonical URL too.
	const alias = resolveLegacyDocSlug(slug)
	if (alias.slug !== slug) {
		return routeLoaderRedirect(
			`${docHref(alias.slug)}${url.search}${alias.fragment ? `#${alias.fragment}` : ''}`,
		)
	}
	return loadDocDetail(slug, signal)
}

/**
 * Doc bodies keep their authored `# Title` for GitHub and raw-markdown
 * readers; the page owns the h1 from frontmatter, so drop the body's
 * leading h1 to avoid rendering the title twice.
 */
function stripLeadingH1(body: string): string {
	return body.replace(/^# [^\n]*\n+/, '')
}

function describeDoc(doc: DocDetailLoaderData): string {
	if (doc.lastVerified) {
		return `Verified against the ${doc.provider ?? 'provider'} console, ${formatLastVerified(doc.lastVerified)}`
	}
	if (doc.audience === 'agents') {
		return 'Agent playbook — written for the agent connected to your account; you can read along'
	}
	return 'Official Kody doc'
}

export function DocDetailRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' | 'not-found' = 'loading'
	let doc: DocDetailLoaderData | null = null
	/** Slug that `doc` / `status` currently describe. */
	let loadedSlug: string | null = null
	const loadLatch = createRouteLoadLatch()

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered body per markdown string (same policy as MarkdownView).
	let renderedForBody: string | null = null
	let renderedBody: Array<RemixNode> = []

	function renderDocBody(body: string) {
		if (renderedForBody !== body) {
			renderedForBody = body
			renderedBody = renderMarkdownNodes(stripLeadingH1(body), {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
				linkPolicy: 'first-party',
				copyCodeBlocks: true,
				fences: doc?.bodyFences,
			})
		}
		return renderedBody
	}

	async function loadDoc(slug: string, signal: AbortSignal) {
		// Do not call handle.update() before the first await — see blog.tsx.
		try {
			const response = await fetch(routes.docDetailApi.href({ slug }), {
				headers: { Accept: 'application/json' },
				signal,
			})
			if (signal.aborted) return
			if (response.status === 404) {
				doc = null
				status = 'not-found'
				loadedSlug = slug
				handle.update()
				return
			}
			const payload = await readJson<DocDetailLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load doc.')
			}
			doc = payload
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
		const slug = getDocSlugFromPathname(readRouterPathname(handle))
		if (!slug || !isDocDetailPath(currentHref)) {
			return <article mix={css(docPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'docDetail',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			doc = routeData
			status = 'ready'
			loadedSlug = routeData.slug
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
					await loadDoc(slug, signal)
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

		// Never show another doc's content after a fast navigation.
		const contentMatchesSlug = loadedSlug === slug
		const showNotFound = status === 'not-found' && contentMatchesSlug
		const showError = status === 'error' && contentMatchesSlug
		const showReady = status === 'ready' && doc !== null && contentMatchesSlug
		const showLoading = !showNotFound && !showError && !showReady
		const section = findDocsNavSection(slug)

		if (showNotFound) {
			return renderDocsShell({
				current: slug,
				children: (
					<article mix={css(docPageCss)}>
						<header mix={css(docHeadCss)}>
							<p mix={css(docEyebrowCss)}>
								<a href={routes.docs.href()}>Docs</a>
							</p>
							<h1>Doc not found</h1>
							<p mix={css(docMetaCss)}>
								That page does not exist or may have moved. Start from{' '}
								<a href={routes.docs.href()}>What is Kody?</a>.
							</p>
						</header>
					</article>
				),
			})
		}

		return renderDocsShell({
			current: slug,
			children: (
				<article mix={css(docPageCss)}>
					{showLoading ? (
						<p mix={css(docStatusCss)} role="status">
							Loading…
						</p>
					) : null}
					{showError ? (
						<p mix={css(docStatusCss)} role="status">
							Unable to load this page.
						</p>
					) : null}
					{showReady && doc ? (
						<>
							<header mix={css(docHeadCss)}>
								<p data-rise style={{ '--rise': '0' }} mix={css(docEyebrowCss)}>
									{doc.category === 'provider' ? (
										<a href={routes.docsConnect.href()}>Connect a provider</a>
									) : (
										(section?.label ?? 'Docs')
									)}
								</p>
								<h1 data-rise style={{ '--rise': '1' }}>
									{doc.title}
								</h1>
								<p data-rise style={{ '--rise': '2' }} mix={css(docMetaCss)}>
									{describeDoc(doc)}
								</p>
							</header>

							{doc.image && doc.imageAlt ? (
								<img
									src={doc.image}
									alt={doc.imageAlt}
									width={1024}
									height={1024}
									loading="eager"
									decoding="async"
									data-rise
									style={{ '--rise': '3' }}
									mix={css(docImageCss)}
								/>
							) : null}

							{interactiveDocRenderers[doc.slug]?.(
								doc.walkthroughHighlights,
								doc.walkthroughHosts,
							) ?? <div mix={css(docProseCss)}>{renderDocBody(doc.body)}</div>}

							{renderDocsPager(doc.slug)}

							<footer mix={css(docFootCss)}>
								<p>
									Working with an agent? This page is also plain markdown at{' '}
									<a
										href={routes.docDetailMarkdown.href({ slug: doc.slug })}
										data-rmx-document
									>
										/docs/{doc.slug}.md
									</a>
									, or load it over MCP with{' '}
									<code>{`search({ entity: '${doc.id}:guide' })`}</code>.
								</p>
							</footer>
						</>
					) : null}
				</article>
			),
		})
	}
}

/* Blog post rhythm on the 43rem measure. */

// Tables scroll inside the article column; the sidebar leaves no room for
// the blog's viewport-centered breakout.
const docProseCss = proseCss

const docPageCss = {
	maxWidth: articleMeasure,
	minWidth: 0,
	padding: 'clamp(2.5rem, 6vw, 4rem) 0 clamp(4rem, 8vw, 6.5rem)',
}

const docEyebrowCss = {
	margin: 0,
	fontSize: '0.8rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
	'& a': {
		color: 'inherit',
		textDecoration: 'none',
	},
}

const docHeadCss = {
	position: 'relative' as const,
	isolation: 'isolate' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-90% -30% -250%',
		background: `radial-gradient(ellipse 46% 55% at 70% 30%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& h1': {
		margin: '0.6rem 0 0',
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p + p': {
		marginTop: '0.9rem',
	},
}

const docMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	'& a': {
		color: colors.primaryText,
	},
}

const docImageCss = {
	display: 'block',
	width: '100%',
	height: 'auto',
	margin: 'clamp(1.5rem, 4vw, 2.2rem) 0 clamp(2rem, 5vw, 3rem)',
	borderRadius: radius.card,
	border: `1px solid ${colors.border}`,
}

const docStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const docFootCss = {
	marginTop: 'clamp(2rem, 5vw, 3rem)',
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
