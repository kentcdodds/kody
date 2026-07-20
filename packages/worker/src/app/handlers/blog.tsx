import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	getBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from '#worker/blog/catalog.ts'
import { buildBlogRssXml } from '#worker/blog/rss.ts'
import { jsonResponse } from '#worker/json-response.ts'

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

export function createBlogPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				return renderAppPage({
					request,
					env,
					title: 'Blog post not found',
					notFound: true,
					status: 404,
				})
			}

			return renderAppPage({
				request,
				env,
				loaderData: {
					blogPost: {
						ok: true,
						slug: post.slug,
						title: post.title,
						date: post.date,
						description: post.description,
						body: post.body,
					},
				},
			})
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

			return jsonResponse({
				ok: true,
				slug: post.slug,
				title: post.title,
				date: post.date,
				description: post.description,
				body: post.body,
			})
		},
	} satisfies Action<typeof routes.blogPostApi>
}

export function createBlogPostOgImageHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const post = getBlogPost(params.slug)
			if (!post) {
				return new Response('Not found', { status: 404 })
			}

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderBlogPostOgImage } = await import('#worker/blog/og-image.ts')
			const png = await renderBlogPostOgImage({
				title: post.title,
				description: post.description,
				date: post.date,
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
