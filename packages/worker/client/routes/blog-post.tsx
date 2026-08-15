import { type Handle, type RemixNode, css } from 'remix/ui'
import {
	BLOG_AUTHOR_NAME,
	BLOG_PLACEHOLDER_CALLOUT,
	formatBlogPostDate,
} from '#universal/blog-display.ts'
import { type BlogPostLoaderData } from '#universal/loader-data.ts'
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
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Blog post, ported from the redesign prototype (`landing/blog-post.html`).
 * A 43rem editorial measure: back link → post head (display title + meta,
 * page-open rise) → AI-placeholder callout → `.prose` body rendered from
 * the server's markdown catalog → quiet foot (read-next pointer + Kody
 * greeting + waitlist button). Nothing here hardcodes post content — body,
 * dates, and the read-next pointer all come from the blog API. The
 * placeholder callout is template chrome until Kent rewrites each post.
 */

export function getSlugFromPathname(pathname: string) {
	const prefix = `${routes.blog.href()}/`
	if (!pathname.startsWith(prefix)) return null
	let slug: string
	try {
		slug = decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ''))
	} catch {
		// Malformed percent-encoding (`/blog/%`) throws. The shell calls this to
		// classify every pathname, so a throw here would take the whole page
		// down instead of just missing a post.
		return null
	}
	// Dots mark non-post paths under /blog (rss.xml, .json APIs); real post
	// slugs are kebab-case and never contain one.
	if (!slug || slug.includes('/') || slug.includes('.')) return null
	return slug
}

function isBlogPostPath(href: string) {
	return (
		getSlugFromPathname(new URL(href, 'http://localhost').pathname) !== null
	)
}

export async function blogPostRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const slug = getSlugFromPathname(url.pathname)
	if (!slug) {
		// Non-post paths under /blog (rss.xml, .json APIs) are served by the
		// worker as raw documents; leave the SPA instead of rendering a
		// missing-post page.
		return routeLoaderRedirect(`${url.pathname}${url.search}`)
	}

	const response = await fetch(routes.blogPostApi.href({ slug }), {
		headers: { Accept: 'application/json' },
		signal,
	})
	if (response.status === 404) {
		throw new Error('Blog post not found.')
	}
	const payload = await readJson<BlogPostLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load blog post.')
	}
	return { blogPost: payload }
}

export function BlogPostRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' | 'not-found' = 'loading'
	let post: BlogPostLoaderData | null = null
	/** Slug that `post` / `status` currently describe; used to hide stale UI. */
	let loadedSlug: string | null = null
	const loadLatch = createRouteLoadLatch()

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered body per markdown string (same policy as MarkdownView).
	let renderedForBody: string | null = null
	let renderedBody: Array<RemixNode> = []

	function renderPostBody(body: string) {
		if (renderedForBody !== body) {
			renderedForBody = body
			// First-party prose: headings keep their authored h2 rhythm and
			// Kent's outbound links are not tagged as user-generated content.
			renderedBody = renderMarkdownNodes(body, {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
			})
		}
		return renderedBody
	}

	async function loadPost(slug: string, signal: AbortSignal) {
		// Do not call handle.update() before the first await — see blog.tsx.
		try {
			const response = await fetch(routes.blogPostApi.href({ slug }), {
				headers: { Accept: 'application/json' },
				signal,
			})
			if (signal.aborted) return
			if (response.status === 404) {
				post = null
				status = 'not-found'
				loadedSlug = slug
				handle.update()
				return
			}
			const payload = await readJson<BlogPostLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load blog post.')
			}
			post = payload
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
		const slug = getSlugFromPathname(readRouterPathname(handle))
		if (!slug || !isBlogPostPath(currentHref)) {
			return <article mix={css(postCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'blogPost', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			post = routeData
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
					await loadPost(slug, signal)
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

		// Never show another post's content: mismatched loadedSlug means the
		// URL already moved on while this closure still holds prior state.
		const contentMatchesSlug = loadedSlug === slug
		const showNotFound = status === 'not-found' && contentMatchesSlug
		const showError = status === 'error' && contentMatchesSlug
		const showReady = status === 'ready' && post !== null && contentMatchesSlug
		const showLoading = !showNotFound && !showError && !showReady

		if (showNotFound) {
			return (
				<article mix={css(postCss)}>
					<a href={routes.blog.href()} mix={css(postBackCss)}>
						← All posts
					</a>
					<header mix={css(postHeadCss)}>
						<h1>Post not found</h1>
						<p mix={css(postMetaCss)}>
							That post does not exist or may have been removed.
						</p>
					</header>
				</article>
			)
		}

		return (
			<article mix={css(postCss)}>
				<a
					data-rise
					style={{ '--rise': '0' }}
					href={routes.blog.href()}
					mix={css(postBackCss)}
				>
					← All posts
				</a>

				{showLoading ? (
					<p mix={css(postStatusCss)} role="status">
						Loading post…
					</p>
				) : null}
				{showError ? (
					<p mix={css(postStatusCss)} role="status">
						Unable to load this blog post.
					</p>
				) : null}
				{showReady && post ? (
					<>
						<header mix={css(postHeadCss)}>
							<h1 data-rise style={{ '--rise': '1' }}>
								{post.title}
							</h1>
							<p data-rise style={{ '--rise': '2' }} mix={css(postMetaCss)}>
								{BLOG_AUTHOR_NAME} · {formatBlogPostDate(post.date)}
							</p>
						</header>

						<aside
							data-rise
							style={{ '--rise': '3' }}
							mix={css(placeholderCalloutCss)}
							role="note"
						>
							<p>{BLOG_PLACEHOLDER_CALLOUT}</p>
						</aside>

						<div mix={css(proseCss)}>{renderPostBody(post.body)}</div>

						<footer mix={css(postFootCss)}>
							{post.readNext ? (
								<a
									href={routes.blogPost.href({ slug: post.readNext.slug })}
									mix={css(readNextCss)}
								>
									<span mix={css(postMetaCss)}>Read next</span>
									<strong>{post.readNext.title}</strong>
								</a>
							) : null}
							<div mix={css(postCtaCss)}>
								<img
									src="/images/kody-greeting.webp"
									width={480}
									height={480}
									alt=""
								/>
								<p>
									Give your assistant a home of its own. Invite-only while we
									grow the eucalyptus.
								</p>
								<a
									href={`${routes.home.href()}#invite`}
									mix={css(postCtaButtonCss)}
								>
									Join the waiting list
								</a>
							</div>
						</footer>
					</>
				) : null}
			</article>
		)
	}
}

/* ---------- styles (prototype: `.post` in landing/styles.css) ---------- */

const postCss = {
	maxWidth: '43rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

const postBackCss = {
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

/* The shared shirt-pattern whisper drifts behind the head, pulled toward the
   reading edge (the post head is left-aligned, unlike the centered page
   head). */
const postHeadCss = {
	position: 'relative' as const,
	// Borrows `pageHeadCss`'s `zIndex: -1` pseudo without the rest of it, so it
	// has to carry the `isolate` that scopes that negative z-index to this
	// element. `blogHeadCss` and timeline's `headCss` spread all of
	// `pageHeadCss` and inherit it for free.
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

const postMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const postStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const placeholderCalloutCss = {
	marginTop: 'clamp(1.4rem, 3vw, 2rem)',
	padding: '1rem 1.15rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	backgroundColor: colors.surface,
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.95rem',
		lineHeight: 1.5,
		maxWidth: '62ch',
		textWrap: 'pretty' as const,
	},
}

/* ---------- post foot: read next + the standing invitation ---------- */

const postFootCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
}

const readNextCss = {
	display: 'block',
	textDecoration: 'none',
	color: 'inherit',
	'& span': {
		display: 'block',
	},
	'& strong': {
		display: 'block',
		marginTop: '0.3rem',
		font: `720 1.25rem/1.25 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.014em',
		transition: `color ${transitions.fast}`,
	},
	'&:hover strong': {
		color: colors.primaryText,
	},
}

const postCtaCss = {
	marginTop: 'clamp(2rem, 5vw, 3rem)',
	display: 'flex',
	alignItems: 'center',
	gap: '1.2rem',
	flexWrap: 'wrap' as const,
	'& img': {
		width: '76px',
		height: '76px',
		flex: 'none',
	},
	'& p': {
		flex: 1,
		minWidth: '16rem',
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
	},
}

const postCtaButtonCss = {
	...getPillButtonCss(),
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
}
