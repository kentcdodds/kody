import { type Handle, css } from 'remix/ui'
import { BLOG_AUTHOR_NAME, formatBlogPostDate } from '#app/blog-display.ts'
import { type BlogLoaderData } from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	layoutMaxWidths,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

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
		status = 'loading'
		handle.update()
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
			return <section mix={css(pageCss)} />
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

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Blog</h1>
					<p mix={css(pageDescriptionCss)}>
						Updates from {BLOG_AUTHOR_NAME} about Kody.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(descriptionCss)}>Loading posts…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(descriptionCss)}>Unable to load blog posts.</p>
				) : null}
				{status === 'ready' ? (
					<ul mix={css(postListCss)}>
						{posts.map((post) => (
							<li key={post.slug} mix={css(postItemCss)}>
								<a
									href={routes.blogPost.href({ slug: post.slug })}
									mix={css(postTitleLinkCss)}
								>
									{post.title}
								</a>
								<p mix={css(postMetaCss)}>{formatBlogPostDate(post.date)}</p>
								<p mix={css(descriptionCss)}>{post.description}</p>
							</li>
						))}
					</ul>
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

const postListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xl,
}

const postItemCss = {
	display: 'grid',
	gap: spacing.xs,
}

const postTitleLinkCss = {
	color: colors.primary,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'none',
	lineHeight: 1.3,
	':hover': {
		textDecoration: 'underline',
	},
}

const postMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
