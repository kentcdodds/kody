import { type Action } from 'remix/router'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getGuideBySlug,
	listMorePlatformGuides,
	listPlatformGuides,
	listProviderGuides,
	listStartHereGuides,
	toGuideSummary,
} from '#worker/guides/catalog.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { type routes } from '#universal/routes.ts'
import { publicSharedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'
import { parseOgTheme } from '#worker/og/palette.ts'
import {
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { collectGoogleOauthSnippets } from '#universal/google-oauth-transcript.ts'
import { collectHowKodyWorksSnippets } from '#universal/how-kody-works-transcript.ts'
import { type GuideDetailLoaderData } from '#universal/loader-data.ts'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { type Guide } from '#worker/guides/parse-frontmatter.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

function appendGuideMarkdownLinks(
	lines: Array<string>,
	guides: ReadonlyArray<Guide>,
	baseUrl: string,
) {
	for (const guide of guides) {
		lines.push(
			`- [${guide.title}](${baseUrl}/guides/${guide.slug}.md) — ${guide.summary}`,
		)
	}
}

/**
 * Main `/guides.md` index: Work with Kody first (Start here + more), then a
 * compact pointer at the connection index — not the full provider dump.
 */
export function buildGuidesIndexMarkdown(baseUrl: string): string {
	const lines = [
		'# Kody guides',
		'',
		'Guides for you and your agent: how Kody works, first builds, and',
		'recipes. Connection walkthroughs (Discord, GitHub, Google, and more)',
		`live on [${baseUrl}/guides/connect.md](${baseUrl}/guides/connect.md).`,
		'Each guide is also available as raw markdown at `/guides/<slug>.md`',
		'(or send `Accept: text/markdown` to the HTML URL).',
		'',
		'## Work with Kody',
		'',
		'### Start here',
		'',
	]
	appendGuideMarkdownLinks(lines, listStartHereGuides(), baseUrl)
	lines.push('', '### More guides', '')
	appendGuideMarkdownLinks(lines, listMorePlatformGuides(), baseUrl)
	lines.push(
		'',
		'## Connect a provider',
		'',
		'How to connect Discord, GitHub, Google, Notion, Origin, Salesforce,',
		'Slack, or Spotify to Kody:',
		`[Connection guides](${baseUrl}/guides/connect.md).`,
		'',
	)
	return lines.join('\n')
}

/**
 * `/guides/connect.md` — verified provider walkthroughs, with a path back to
 * Work with Kody for people who landed on connect first.
 */
export function buildGuidesConnectMarkdown(baseUrl: string): string {
	const lines = [
		'# Connect a provider',
		'',
		'Verified walkthroughs for connecting Discord, GitHub, Google, Notion,',
		'Origin, Salesforce, Slack, or Spotify to Kody. Each guide covers',
		'console steps, endpoints, scopes, gotchas, and a smoke test.',
		'',
		'Looking for how Kody works instead? Start with',
		`[Work with Kody](${baseUrl}/guides.md) or`,
		`[How Kody works](${baseUrl}/guides/how-kody-works.md).`,
		'',
		'## Provider guides',
		'',
	]
	appendGuideMarkdownLinks(lines, listProviderGuides(), baseUrl)
	lines.push(
		'',
		'## Related',
		'',
		`- [Connect a home MCP server](${baseUrl}/guides/local-mcp-tunnels.md) — run a local MCP process and connect it to Kody`,
		`- [Work with Kody](${baseUrl}/guides.md) — fundamentals and recipes`,
		'',
	)
	return lines.join('\n')
}

function collectWalkthroughSnippets(slug: string) {
	switch (slug) {
		case 'how-kody-works':
			return collectHowKodyWorksSnippets()
		case 'google-oauth':
			return collectGoogleOauthSnippets()
		default:
			return []
	}
}

async function highlightWalkthrough(
	env: Env,
	slug: string,
	serverTiming?: Array<ServerTimingEntry>,
) {
	const snippets = uniqueHighlightSnippets(collectWalkthroughSnippets(slug))
	if (snippets.length === 0) return undefined
	return highlightResultsByKey(
		snippets,
		await highlightSnippets(env, snippets, { serverTiming }),
	)
}

async function toGuideDetail(
	env: Env,
	guide: Guide,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<GuideDetailLoaderData> {
	const [bodyFences, walkthroughHighlights] = await Promise.all([
		highlightMarkdownFences(env, guide.body, { serverTiming }),
		highlightWalkthrough(env, guide.slug, serverTiming),
	])
	return {
		ok: true,
		slug: guide.slug,
		id: guide.id,
		title: guide.title,
		summary: guide.summary,
		category: guide.category,
		image: guide.image,
		imageAlt: guide.imageAlt,
		ogImage: guide.ogImage,
		provider: guide.provider,
		lastVerified: guide.lastVerified,
		body: guide.body,
		bodyFences,
		...(walkthroughHighlights ? { walkthroughHighlights } : {}),
		...(guide.slug === 'how-kody-works'
			? { walkthroughHosts: pickWalkthroughHosts() }
			: {}),
	}
}

export function createGuidesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				return markdownResponse(buildGuidesIndexMarkdown(baseUrl))
			}
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					title: 'Guides',
					loaderData: {
						guides: {
							ok: true,
							guides: listPlatformGuides().map(toGuideSummary),
						},
					},
				}),
			)
		},
	} satisfies Action<typeof routes.guides>
}

export function createGuidesApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				guides: listPlatformGuides().map(toGuideSummary),
			})
		},
	} satisfies Action<typeof routes.guidesApi>
}

export function createGuidesMarkdownHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			return markdownResponse(buildGuidesIndexMarkdown(baseUrl))
		},
	} satisfies Action<typeof routes.guidesMarkdown>
}

export function createGuidesConnectHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				return markdownResponse(buildGuidesConnectMarkdown(baseUrl))
			}
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					title: 'Connect a provider',
					loaderData: {
						guidesConnect: {
							ok: true,
							guides: listProviderGuides().map(toGuideSummary),
						},
					},
				}),
			)
		},
	} satisfies Action<typeof routes.guidesConnect>
}

export function createGuidesConnectApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				guides: listProviderGuides().map(toGuideSummary),
			})
		},
	} satisfies Action<typeof routes.guidesConnectApi>
}

export function createGuidesConnectMarkdownHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			return markdownResponse(buildGuidesConnectMarkdown(baseUrl))
		},
	} satisfies Action<typeof routes.guidesConnectMarkdown>
}

export function createGuideDetailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				if (prefersMarkdown(request)) {
					return markdownResponse('# Guide not found\n', 404)
				}
				return withVaryAccept(
					await renderAppPage({
						request,
						env,
						title: 'Guide not found',
						notFound: true,
						status: 404,
					}),
				)
			}
			if (prefersMarkdown(request)) {
				return markdownResponse(guide.body)
			}
			const serverTiming: Array<ServerTimingEntry> = []
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					loaderData: {
						guideDetail: await toGuideDetail(env, guide, serverTiming),
					},
					serverTiming,
				}),
			)
		},
	} satisfies Action<typeof routes.guideDetail>
}

export function createGuideDetailApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return jsonResponse({ ok: false, error: 'Guide not found.' }, 404)
			}
			const serverTiming: Array<ServerTimingEntry> = []
			return jsonResponse(await toGuideDetail(env, guide, serverTiming), {
				serverTiming,
				headers: publicSharedJsonCacheHeaders(),
			})
		},
	} satisfies Action<typeof routes.guideDetailApi>
}

export function createGuideDetailMarkdownHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return markdownResponse('# Guide not found\n', 404)
			}
			return markdownResponse(guide.body)
		},
	} satisfies Action<typeof routes.guideDetailMarkdown>
}

export function createGuideDetailOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const guide = getGuideBySlug(params.slug)
			const ogImage = guide?.ogImage ?? guide?.image
			if (!guide || !ogImage) {
				return new Response('Not found', { status: 404 })
			}

			const imageResponse = await env.ASSETS.fetch(
				new Request(new URL(ogImage, request.url)),
			)
			if (!imageResponse.ok) {
				return new Response('Guide artwork unavailable', { status: 502 })
			}
			const contentType =
				imageResponse.headers.get('content-type') ?? 'image/webp'
			const imageDataUri = `data:${contentType};base64,${bytesToBase64(
				new Uint8Array(await imageResponse.arrayBuffer()),
			)}`
			const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

			// Deployment requires this lazy boundary: eagerly importing Satori and
			// Resvg makes the main Worker exceed Cloudflare's startup CPU limit.
			const { renderGuideOgImage } = await import('#worker/guides/og-image.ts')
			const png = await renderGuideOgImage({
				title: guide.title,
				description: guide.summary,
				imageDataUri,
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
	} satisfies Action<typeof routes.guideDetailOgImage>
}
