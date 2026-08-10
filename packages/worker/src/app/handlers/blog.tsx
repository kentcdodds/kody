import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	getBlogPost,
	getReadNextBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from '#worker/blog/catalog.ts'
import { type BlogPost } from '#worker/blog/parse-frontmatter.ts'
import { buildBlogRssXml } from '#worker/blog/rss.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

export function createBlogHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const posts = listBlogPosts().map(toBlogPostSummary)

			return renderAppPage({
				request,
				env,
				loaderData: {
					blog: { ok: true, posts },
				},
			})
		},
	} satisfies Action<typeof routes.blog>
}

export function createBlogApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				posts: listBlogPosts().map(toBlogPostSummary),
			})
		},
	} satisfies Action<typeof routes.blogApi>
}

/** Loader payload shared by the SSR page and the JSON API. */
function toBlogPostLoaderData(post: BlogPost) {
	return {
		ok: true as const,
		slug: post.slug,
		title: post.title,
		date: post.date,
		description: post.description,
		body: post.body,
		readNext: getReadNextBlogPost(post.slug),
	}
}

export function createBlogPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				if (prefersMarkdown(request)) {
					return markdownResponse('# Blog post not found\n', 404)
				}
				return withVaryAccept(
					await renderAppPage({
						request,
						env,
						title: 'Blog post not found',
						notFound: true,
						status: 404,
					}),
				)
			}
			if (prefersMarkdown(request)) {
				return markdownResponse(post.body)
			}

			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					loaderData: {
						blogPost: toBlogPostLoaderData(post),
					},
				}),
			)
		},
	} satisfies Action<typeof routes.blogPost>
}

export function createBlogPostApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				return jsonResponse({ ok: false, error: 'Blog post not found.' }, 404)
			}

			return jsonResponse(toBlogPostLoaderData(post))
		},
	} satisfies Action<typeof routes.blogPostApi>
}

export function createBlogPostMarkdownHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				return markdownResponse('# Blog post not found\n', 404)
			}
			return markdownResponse(post.body)
		},
	} satisfies Action<typeof routes.blogPostMarkdown>
}

export function createBlogPostOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				return new Response('Not found', { status: 404 })
			}

			// `?theme=light` renders the pale variant; anything unrecognised
			// falls back to the default rather than erroring.
			const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderBlogPostOgImage } = await import('#worker/blog/og-image.ts')
			const png = await renderBlogPostOgImage({
				title: post.title,
				description: post.description,
				date: post.date,
				theme,
				assets: env.ASSETS,
			})

			return new Response(png, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=3600',
					'Content-Type': 'image/png',
				},
			})
		},
	} satisfies Action<typeof routes.blogPostOgImage>
}

export function createBlogRssHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			const xml = buildBlogRssXml({
				origin,
				posts: listBlogPosts(),
			})

			return new Response(xml, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=300',
					'Content-Type': 'application/rss+xml; charset=utf-8',
				},
			})
		},
	} satisfies Action<typeof routes.blogRss>
}
