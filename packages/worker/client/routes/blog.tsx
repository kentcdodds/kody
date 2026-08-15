import { type Handle, css } from 'remix/ui'
import {
	BLOG_AUTHOR_NAME,
	formatBlogPostDate,
} from '#universal/blog-display.ts'
import {
	type BlogLoaderData,
	type BlogPostSummaryLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { revealCard } from '#client/reveal.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { hoverMq, pageHeadCss } from '#universal/styles/style-primitives.ts'

/**
 * Blog index, ported from the redesign prototype (`landing/blog.html`).
 * Left-aligned editorial column on a 46rem measure. The newest post (the
 * server orders by date desc, then `order` frontmatter) is featured with
 * mascot art; the rest is a flat hairline-divided list. All post content
 * comes from the server's markdown catalog — nothing is hardcoded here.
 */

const blogApiPath = routes.blogApi.href()

function isBlogIndexPath(href: string) {
	return new URL(href, 'http://localhost').pathname === routes.blog.href()
}

export async function blogRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(blogApiPath, {
		headers: { Accept: 'application/json' },
		signal,
	})
	const payload = await readJson<BlogLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load blog posts.')
	}
	return { blog: payload }
}

export function BlogRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let posts: BlogLoaderData['posts'] = []
	const loadLatch = createRouteLoadLatch()

	async function loadBlog(signal: AbortSignal) {
		// Do not call handle.update() before the first await. Remix aborts this
		// queueTask on re-render; an early update aborts the fetch, needsLoad
		// re-queues, and the scheduler hits "infinite loop detected".
		try {
			const response = await fetch(blogApiPath, {
				headers: { Accept: 'application/json' },
				signal,
			})
			const payload = await readJson<BlogLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load blog posts.')
			}
			posts = payload.posts
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
		if (!isBlogIndexPath(currentHref)) {
			return <section mix={css(blogPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'blog', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			posts = routeData.posts
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
					await loadBlog(signal)
					if (signal.aborted) return
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					if (signal.aborted) return
					loadLatch.markFailed(currentHref)
				}
			})
		}

		const [featuredPost, ...listPosts] = posts

		return (
			<section mix={css(blogPageCss)}>
				<header mix={css(blogHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Notes from the <em>eucalyptus</em>
					</h1>
					<p data-rise style={{ '--rise': '1' }}>
						Why your assistant deserves a home, written while building it. From{' '}
						{BLOG_AUTHOR_NAME}.
					</p>
					<a
						data-rise
						style={{ '--rise': '2' }}
						href={routes.blogRss.href()}
						mix={css(rssLinkCss)}
					>
						Subscribe via RSS
					</a>
				</header>

				{status === 'loading' ? (
					<p mix={css(listStatusCss)}>Loading posts…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(listStatusCss)}>Unable to load blog posts.</p>
				) : null}
				{status === 'ready' && featuredPost ? (
					<ul mix={css(postListCss)}>
						{renderFeaturedPostItem(featuredPost)}
						{listPosts.map((post, index) => renderPostItem(post, index + 1))}
					</ul>
				) : null}
			</section>
		)
	}
}

/**
 * The newest post gets Kody at its side; everything below stays a list.
 * Reveal delays mirror the prototype's post-list stagger: 60ms steps,
 * capped at the fourth item.
 */
function renderFeaturedPostItem(post: BlogPostSummaryLoaderData) {
	return (
		<li key={post.slug} mix={[css(featuredItemCss), revealCard()]}>
			<a
				href={routes.blogPost.href({ slug: post.slug })}
				mix={css(featuredLinkCss)}
			>
				<div>
					<p mix={css(postMetaCss)}>{formatBlogPostDate(post.date)}</p>
					<h2 mix={css(featuredTitleCss)}>{post.title}</h2>
					<p mix={css(featuredDescriptionCss)}>{post.description}</p>
				</div>
				<img
					src="/images/kody-agent-briefing.webp"
					width={480}
					height={480}
					/*
					 * Decorative. The img sits inside the anchor, so alt text is
					 * appended to the link's accessible name — a screen reader
					 * would announce the date, title, description, and then a
					 * mascot description as one long link name. The art says
					 * nothing the copy does not already say.
					 */
					alt=""
					mix={css(featuredArtCss)}
				/>
			</a>
		</li>
	)
}

function renderPostItem(post: BlogPostSummaryLoaderData, index: number) {
	return (
		<li
			key={post.slug}
			mix={[css(postItemCss), revealCard(Math.min(index, 3) * 60)]}
		>
			<a
				href={routes.blogPost.href({ slug: post.slug })}
				mix={css(postLinkCss)}
			>
				<p mix={css(postMetaCss)}>{formatBlogPostDate(post.date)}</p>
				<h2 mix={css(postTitleCss)}>{post.title}</h2>
				<p mix={css(postDescriptionCss)}>{post.description}</p>
			</a>
		</li>
	)
}

/* ---------- styles ---------- */

const blogPageCss = {
	maxWidth: '46rem',
	marginInline: 'auto',
	padding:
		'clamp(3rem, 7vw, 5.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

/* The shared page-head scaffold, pulled left for the editorial column; the
   shirt-pattern whisper drifts off-center toward the reading edge. */
const blogHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-70% -30% -200%',
		background: `radial-gradient(ellipse 48% 60% at 72% 36%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& > p': {
		...pageHeadCss['& > p'],
		marginInline: 0,
	},
}

const rssLinkCss = {
	marginTop: '1.2rem',
	display: 'inline-flex',
	fontSize: '0.92rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': {
		color: colors.text,
	},
}

const listStatusCss = {
	margin: 'clamp(2rem, 5vw, 3rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const postListCss = {
	listStyle: 'none',
	margin: 'clamp(2rem, 5vw, 3rem) 0 0',
	padding: 0,
}

const postItemCss = {
	borderBottom: `1px solid ${colors.border}`,
	'&:first-child': {
		borderTop: `1px solid ${colors.border}`,
	},
}

const postLinkCss = {
	display: 'block',
	padding: '1.6rem 0.2rem',
	textDecoration: 'none',
	color: 'inherit',
	'&:hover h2': {
		color: colors.primaryText,
	},
}

const postMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const postTitleCss = {
	margin: '0.35rem 0 0',
	fontSize: '1.4rem',
	fontWeight: 720,
	letterSpacing: '-0.016em',
	lineHeight: 1.2,
	textWrap: 'balance' as const,
	transition: `color ${transitions.fast}`,
}

const postDescriptionCss = {
	margin: '0.5rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '58ch',
	textWrap: 'balance' as const,
}

/* Featured description sits outside the prototype's balance list — it wraps
   long, where `pretty` reads better than strict balancing. */
const featuredDescriptionCss = {
	...postDescriptionCss,
	textWrap: 'pretty' as const,
}

/* ---------- featured (newest) post ---------- */

const featuredItemCss = {
	border: 'none',
}

const featuredLinkCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(130px, 20vw, 190px)',
	gap: 'clamp(1.2rem, 3vw, 2.2rem)',
	alignItems: 'center',
	padding: '0 0.2rem clamp(1.8rem, 4vw, 2.5rem)',
	textDecoration: 'none',
	color: 'inherit',
	'&:hover h2': {
		color: colors.primaryText,
	},
	// Gated: touch taps would otherwise leave the mascot stuck mid-lift.
	[hoverMq]: {
		'&:hover img': {
			transform: 'translateY(-6px) rotate(-0.5deg)',
		},
	},
	'@media (max-width: 560px)': {
		gridTemplateColumns: '1fr',
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:hover img': {
			transform: 'none',
		},
	},
}

const featuredTitleCss = {
	...postTitleCss,
	fontSize: 'clamp(1.6rem, 3.2vw, 2rem)',
}

const featuredArtCss = {
	width: '100%',
	height: 'auto',
	transition: `transform 200ms ${transitions.easeOut}`,
	'@media (max-width: 560px)': {
		width: 'min(52%, 200px)',
		marginInline: 'auto',
		order: -1,
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
	},
}
