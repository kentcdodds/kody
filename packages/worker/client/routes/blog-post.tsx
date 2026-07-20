import { type Handle, css } from 'remix/ui'
import { BLOG_AUTHOR_NAME, formatBlogPostDate } from '#app/blog-display.ts'
import { type BlogPostLoaderData } from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { MarkdownView } from '#client/markdown-view.tsx'
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
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	layoutMaxWidths,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

function getSlugFromPathname(pathname: string) {
	const prefix = `${routes.blog.href()}/`
	if (!pathname.startsWith(prefix)) return null
	const slug = decodeURIComponent(
		pathname.slice(prefix.length).replace(/\/$/, ''),
	)
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

	async function loadPost(slug: string, signal: AbortSignal) {
		status = 'loading'
		handle.update()
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
			return <section mix={css(pageCss)} />
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
			handle.queueTask(async (signal) => {
				try {
					await loadPost(slug, signal)
					if (signal.aborted) return
					if (status === 'ready' || status === 'not-found') {
						loadLatch.markLoaded(currentHref)
					} else {
						loadLatch.markFailed(currentHref)
					}
				} catch {
					if (signal.aborted) return
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
				<section mix={css(pageCss)}>
					<header mix={css(pageHeaderCss)}>
						<h1 mix={css(pageTitleCss)}>Blog post not found</h1>
						<p mix={css(pageDescriptionCss)}>
							That post does not exist or may have been removed.
						</p>
					</header>
					<p mix={css({ margin: 0 })}>
						<a href={routes.blog.href()} mix={css(mutedLinkCss)}>
							Back to blog
						</a>
					</p>
				</section>
			)
		}

		return (
			<section mix={css(pageCss)}>
				{showLoading ? <p mix={css(descriptionCss)}>Loading post…</p> : null}
				{showError ? (
					<p mix={css(descriptionCss)}>Unable to load this blog post.</p>
				) : null}
				{showReady && post ? (
					<>
						<header mix={css(pageHeaderCss)}>
							<h1 mix={css(pageTitleCss)}>{post.title}</h1>
							<p mix={css(pageDescriptionCss)}>
								{formatBlogPostDate(post.date)} · {BLOG_AUTHOR_NAME}
							</p>
						</header>

						<section mix={css(cardCss)}>
							<div mix={css(bodyCss)}>
								<MarkdownView markdown={post.body} />
							</div>
						</section>

						<p mix={css({ margin: 0 })}>
							<a href={routes.blog.href()} mix={css(mutedLinkCss)}>
								Back to blog
							</a>
						</p>
					</>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: layoutMaxWidths.narrow,
	margin: '0 auto',
}

const bodyCss = {
	color: colors.text,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.7,
	display: 'grid',
	gap: spacing.md,
}
