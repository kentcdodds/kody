import { type Action } from 'remix/router'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getGuideBySlug,
	getIntroGuide,
	listGuides,
	listGuidesBySection,
	listProviderGuides,
	toGuideSummary,
} from '#worker/guides/catalog.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { type routes } from '#universal/routes.ts'
import {
	docMarkdownHref,
	docsIntroSlug,
	resolveLegacyDocSlug,
} from '#universal/docs-nav.ts'
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
import { type DocDetailLoaderData } from '#universal/loader-data.ts'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { type Guide } from '#worker/guides/parse-frontmatter.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

function appendDocMarkdownLinks(
	lines: Array<string>,
	guides: ReadonlyArray<Guide>,
	baseUrl: string,
) {
	for (const guide of guides) {
		lines.push(
			`- [${guide.title}](${baseUrl}${docMarkdownHref(guide.slug)}) — ${guide.summary}`,
		)
	}
}

/**
 * Sectioned index of every advertised doc, shared by `/docs.md` (after the
 * introduction) and `/llms.txt`.
 */
export function buildDocsIndexSections(baseUrl: string): Array<string> {
	const lines: Array<string> = []
	for (const { section, guides } of listGuidesBySection()) {
		if (guides.length === 0) continue
		lines.push(`## ${section.label}`, '', section.description, '')
		appendDocMarkdownLinks(lines, guides, baseUrl)
		lines.push('')
	}
	return lines
}

/**
 * `/docs.md`: the introduction article followed by the full sectioned index,
 * so an agent that fetches the docs root gets both the pitch and a map.
 */
export function buildDocsIndexMarkdown(baseUrl: string): string {
	const intro = getIntroGuide()
	const lines = [
		intro.body.trimEnd(),
		'',
		'---',
		'',
		'# All Kody docs',
		'',
		'Every page is plain markdown at `/docs/<slug>.md` (or send',
		'`Accept: text/markdown` to the HTML URL) and available over MCP as',
		'`search({ entity: "{id}:guide" })`. Compact index:',
		`[${baseUrl}/llms.txt](${baseUrl}/llms.txt).`,
		'',
		...buildDocsIndexSections(baseUrl),
	]
	return lines.join('\n')
}

/**
 * `/llms.txt` (also `/docs/llms.txt`): the llmstxt.org-style index — one
 * line per doc with its markdown twin and summary.
 */
export function buildLlmsTxt(baseUrl: string): string {
	const lines = [
		'# Kody',
		'',
		'> Kody is the home your agents share: connect the AI agent you already',
		'> use over MCP and it gains durable memory, secrets it never reads, saved',
		'> packages, jobs, workflows, webhooks, and apps that keep running while',
		'> you are offline — and every other agent you connect reuses the same',
		'> home.',
		'',
		`Start with [What is Kody?](${baseUrl}/docs.md). Every doc below is`,
		'plain markdown; the same content is available to connected agents as',
		'`search({ entity: "{id}:guide" })`.',
		'',
		...buildDocsIndexSections(baseUrl),
		'## Optional',
		'',
		`- [Blog](${baseUrl}/blog): essays on owning your automations`,
		`- [Connect your agent (machine-readable)](${baseUrl}/auth.md): OAuth and MCP endpoint details`,
		'',
	]
	return lines.join('\n')
}

/**
 * `/docs/connect.md` — verified provider walkthroughs, with a path back to
 * the introduction for people who landed on connect first.
 */
export function buildDocsConnectMarkdown(baseUrl: string): string {
	const lines = [
		'# Connect a provider',
		'',
		'Verified walkthroughs for connecting Discord, GitHub, Google, Notion,',
		'Origin, Salesforce, Slack, or Spotify to Kody. Each doc covers console',
		'steps, endpoints, scopes, gotchas, and a smoke test.',
		'',
		'Looking for how Kody works instead? Start with',
		`[What is Kody?](${baseUrl}/docs.md) or`,
		`[How Kody works](${baseUrl}${docMarkdownHref('how-kody-works')}).`,
		'',
		'## Provider docs',
		'',
	]
	appendDocMarkdownLinks(lines, listProviderGuides(), baseUrl)
	lines.push(
		'',
		'## Related',
		'',
		`- [Integration bootstrap](${baseUrl}${docMarkdownHref('integration-bootstrap')}) — the sequence before any provider-backed package`,
		`- [OAuth (bring your own app)](${baseUrl}${docMarkdownHref('oauth')}) — the standard \`/connect/oauth\` path for providers without a walkthrough`,
		`- [Connect a home MCP server](${baseUrl}${docMarkdownHref('local-mcp-tunnels')}) — run a local MCP process and connect it to Kody`,
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

async function toDocDetail(
	env: Env,
	guide: Guide,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<DocDetailLoaderData> {
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
		audience: guide.audience,
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

function permanentRedirect(location: string): Response {
	return new Response(null, {
		status: 308,
		headers: { Location: location, 'Cache-Control': 'public, max-age=3600' },
	})
}

function withSearch(pathname: string, request: Request): string {
	return `${pathname}${new URL(request.url).search}`
}

/**
 * Old slugs (merged docs) redirect to the absorbing page. Returns null when
 * `slug` should be served as-is. The introduction is served at both `/docs`
 * and `/docs/what-is-kody` (canonical `/docs`) rather than redirected, so
 * agent fetchers that do not follow redirects still get the markdown.
 */
function docDetailRedirect(
	slug: string,
	request: Request,
	twin: '' | '.md' | '.json' | '/og.png',
): Response | null {
	const alias = resolveLegacyDocSlug(slug)
	if (alias.slug === slug) return null
	const fragment = twin === '' && alias.fragment ? `#${alias.fragment}` : ''
	return permanentRedirect(
		`${withSearch(`/docs/${alias.slug}${twin}`, request)}${fragment}`,
	)
}

async function renderDocPage(
	env: Env,
	request: Request,
	guide: Guide,
): Promise<Response> {
	const serverTiming: Array<ServerTimingEntry> = []
	return withVaryAccept(
		await renderAppPage({
			request,
			env,
			loaderData: {
				docDetail: await toDocDetail(env, guide, serverTiming),
			},
			serverTiming,
		}),
	)
}

export function createDocsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				return markdownResponse(buildDocsIndexMarkdown(baseUrl))
			}
			return renderDocPage(env, request, getIntroGuide())
		},
	} satisfies Action<typeof routes.docs>
}

export function createDocsApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				intro: docsIntroSlug,
				sections: listGuidesBySection().map(({ section, guides }) => ({
					id: section.id,
					label: section.label,
					description: section.description,
					slugs: guides.map((guide) => guide.slug),
				})),
				guides: listGuides().map(toGuideSummary),
			})
		},
	} satisfies Action<typeof routes.docsApi>
}

export function createDocsMarkdownHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			return markdownResponse(buildDocsIndexMarkdown(baseUrl))
		},
	} satisfies Action<typeof routes.docsMarkdown>
}

function llmsTxtResponse(env: Env, request: Request): Response {
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	return new Response(buildLlmsTxt(baseUrl), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=300',
		},
	})
}

export function createLlmsTxtHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return llmsTxtResponse(env, request)
		},
	} satisfies Action<typeof routes.llmsTxt>
}

export function createDocsLlmsTxtHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return llmsTxtResponse(env, request)
		},
	} satisfies Action<typeof routes.docsLlmsTxt>
}

export function createDocsConnectHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				return markdownResponse(buildDocsConnectMarkdown(baseUrl))
			}
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					title: 'Connect a provider',
					loaderData: {
						docsConnect: {
							ok: true,
							guides: listProviderGuides().map(toGuideSummary),
						},
					},
				}),
			)
		},
	} satisfies Action<typeof routes.docsConnect>
}

export function createDocsConnectApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				guides: listProviderGuides().map(toGuideSummary),
			})
		},
	} satisfies Action<typeof routes.docsConnectApi>
}

export function createDocsConnectMarkdownHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			return markdownResponse(buildDocsConnectMarkdown(baseUrl))
		},
	} satisfies Action<typeof routes.docsConnectMarkdown>
}

export function createDocDetailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const markdown = prefersMarkdown(request)
			const redirect = docDetailRedirect(
				params.slug,
				request,
				markdown ? '.md' : '',
			)
			if (redirect) return redirect
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				if (markdown) {
					return markdownResponse('# Doc not found\n', 404)
				}
				return withVaryAccept(
					await renderAppPage({
						request,
						env,
						title: 'Doc not found',
						notFound: true,
						status: 404,
					}),
				)
			}
			if (markdown) {
				return markdownResponse(guide.body)
			}
			return renderDocPage(env, request, guide)
		},
	} satisfies Action<typeof routes.docDetail>
}

export function createDocDetailApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const redirect = docDetailRedirect(params.slug, request, '.json')
			if (redirect) return redirect
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return jsonResponse({ ok: false, error: 'Doc not found.' }, 404)
			}
			const serverTiming: Array<ServerTimingEntry> = []
			return jsonResponse(await toDocDetail(env, guide, serverTiming), {
				serverTiming,
				headers: publicSharedJsonCacheHeaders(),
			})
		},
	} satisfies Action<typeof routes.docDetailApi>
}

export function createDocDetailMarkdownHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const redirect = docDetailRedirect(params.slug, request, '.md')
			if (redirect) return redirect
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return markdownResponse('# Doc not found\n', 404)
			}
			return markdownResponse(guide.body)
		},
	} satisfies Action<typeof routes.docDetailMarkdown>
}

export function createDocDetailOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const redirect = docDetailRedirect(params.slug, request, '/og.png')
			if (redirect) return redirect
			const guide = getGuideBySlug(params.slug)
			const ogImage = guide?.ogImage ?? guide?.image
			if (!guide || !ogImage) {
				return new Response('Not found', { status: 404 })
			}

			const imageResponse = await env.ASSETS.fetch(
				new Request(new URL(ogImage, request.url)),
			)
			if (!imageResponse.ok) {
				return new Response('Doc artwork unavailable', { status: 502 })
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
	} satisfies Action<typeof routes.docDetailOgImage>
}
