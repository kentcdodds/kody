import { expect, test } from 'vitest'
import { uniqueHighlightSnippets } from '#app/highlight-code.ts'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import {
	collectHowKodyWorksSnippets,
	howKodyWorksPackageFiles,
} from '#universal/how-kody-works-transcript.ts'
import { collectGoogleOauthSnippets } from '#universal/google-oauth-transcript.ts'
import {
	isValidWalkthroughHostPick,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import {
	getGuideBySlug,
	listGuides,
	listProviderGuides,
} from '#worker/guides/catalog.ts'
import { docsNav, listDocsNavSlugs } from '#universal/docs-nav.ts'
import {
	createDocDetailApiHandler,
	createDocDetailMarkdownHandler,
	createDocsApiHandler,
	createDocsConnectApiHandler,
	createDocsConnectMarkdownHandler,
	createDocsMarkdownHandler,
	createLlmsTxtHandler,
} from './docs.tsx'
import { resolveLegacyGuidesLocation } from './legacy-guides-redirect.ts'

const env = { APP_BASE_URL: 'https://kody.example' } as Env

type HandlerArgs = { request: Request; params: { slug: string } }

function callHandler(
	action: { handler: (args: HandlerArgs) => Promise<Response> },
	args: HandlerArgs,
) {
	return action.handler(args)
}

test('docs API lists every advertised doc by section and the markdown root is intro plus index', async () => {
	const apiResponse = await callHandler(createDocsApiHandler(env) as never, {
		request: new Request('https://kody.example/docs.json'),
		params: { slug: '' },
	})
	expect(apiResponse.status).toBe(200)
	const payload = (await apiResponse.json()) as {
		ok: boolean
		intro: string
		sections: Array<{ id: string; label: string; slugs: Array<string> }>
		guides: Array<{
			slug: string
			id: string
			title: string
			category: string
			section: string | null
			audience: string
		}>
	}
	expect(payload.ok).toBe(true)
	expect(payload.intro).toBe('what-is-kody')
	expect(payload.guides.length).toBe(listGuides().length)
	expect(payload.guides.map((guide) => guide.slug)).toEqual(listDocsNavSlugs())
	expect(payload.guides.some((guide) => guide.id === 'values')).toBe(false)
	expect(
		payload.guides.some(
			(guide) => guide.id === 'package_invocation_token_setup',
		),
	).toBe(false)
	expect(payload.guides.every((guide) => guide.section !== null)).toBe(true)
	expect(payload.sections.map((section) => section.id)).toEqual(
		docsNav.map((section) => section.id),
	)
	expect(payload.guides[0]?.slug).toBe('what-is-kody')
	expect(
		payload.guides.find((guide) => guide.slug === 'onboarding')?.audience,
	).toBe('agents')
	// Bodies stay out of the index payload.
	expect(JSON.stringify(payload)).not.toContain('## ')

	const markdownIndex = await callHandler(
		createDocsMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs.md'),
			params: { slug: '' },
		},
	)
	expect(markdownIndex.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	const indexBody = await markdownIndex.text()
	expect(indexBody.startsWith('# What is Kody?')).toBe(true)
	expect(indexBody).toContain('# All Kody docs')
	expect(indexBody).toContain('https://kody.example/llms.txt')
	for (const section of docsNav) {
		expect(indexBody).toContain(`## ${section.label}`)
	}
	expect(indexBody.indexOf('## Introduction')).toBeLessThan(
		indexBody.indexOf('## Get started'),
	)
	expect(indexBody.indexOf('## Concepts')).toBeLessThan(
		indexBody.indexOf('## Connect a provider'),
	)
	for (const guide of listGuides()) {
		expect(indexBody).toContain(`https://kody.example/docs/${guide.slug}.md`)
	}
	expect(indexBody).not.toContain('https://kody.example/docs/values.md')
	expect(indexBody).not.toContain('/guides/')

	const llms = await callHandler(createLlmsTxtHandler(env) as never, {
		request: new Request('https://kody.example/llms.txt'),
		params: { slug: '' },
	})
	expect(llms.status).toBe(200)
	expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	const llmsBody = await llms.text()
	expect(llmsBody.startsWith('# Kody\n')).toBe(true)
	for (const guide of listGuides()) {
		expect(llmsBody).toContain(
			`[${guide.title}](https://kody.example/docs/${guide.slug}.md)`,
		)
	}
	expect(llmsBody).not.toContain('/docs/values.md')
})

test('legacy /guides URLs resolve to their /docs twins', () => {
	const cases: Array<[string, string]> = [
		['/guides', '/docs'],
		['/guides.md', '/docs.md'],
		['/guides.json', '/docs.json'],
		['/guides/connect', '/docs/connect'],
		['/guides/connect.md', '/docs/connect.md'],
		['/guides/connect.json', '/docs/connect.json'],
		['/guides/what-is-kody', '/docs/what-is-kody'],
		['/guides/what-is-kody.md', '/docs/what-is-kody.md'],
		['/guides/oauth', '/docs/oauth'],
		['/guides/oauth.md', '/docs/oauth.md'],
		['/guides/oauth.json', '/docs/oauth.json'],
		['/guides/kody-factory/og.png', '/docs/kody-factory/og.png'],
		['/guides/oauth?utm=x', '/docs/oauth?utm=x'],
		[
			'/guides/integration-backed-app-happy-path',
			'/docs/package-apps#after-an-integration-smoke-test',
		],
		['/guides/integration-backed-app-happy-path.md', '/docs/package-apps.md'],
		['/guides/nope', '/docs/nope'],
	]
	expect(
		cases.map(([from]) => [
			from,
			resolveLegacyGuidesLocation(new URL(from, 'https://kody.example')),
		]),
	).toEqual(cases)
})

test('merged doc slugs 308 to the absorbing doc on every twin', async () => {
	const html = await callHandler(createDocDetailApiHandler(env) as never, {
		request: new Request(
			'https://kody.example/docs/integration-backed-app-happy-path.json',
		),
		params: { slug: 'integration-backed-app-happy-path' },
	})
	expect(html.status).toBe(308)
	expect(html.headers.get('Location')).toBe('/docs/package-apps.json')

	const markdown = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request(
				'https://kody.example/docs/integration-backed-app-happy-path.md',
			),
			params: { slug: 'integration-backed-app-happy-path' },
		},
	)
	expect(markdown.status).toBe(308)
	expect(markdown.headers.get('Location')).toBe('/docs/package-apps.md')
})

test('docs connect index serves JSON and markdown without colliding with doc slugs', async () => {
	const apiResponse = await callHandler(
		createDocsConnectApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/connect.json'),
			params: { slug: '' },
		},
	)
	expect(apiResponse.status).toBe(200)
	const payload = (await apiResponse.json()) as {
		ok: boolean
		guides: Array<{
			slug: string
			category: string
			provider: string | null
		}>
	}
	expect(payload.ok).toBe(true)
	expect(payload.guides.length).toBe(listProviderGuides().length)
	expect(payload.guides.every((guide) => guide.category === 'provider')).toBe(
		true,
	)
	expect(payload.guides.map((guide) => guide.provider)).toEqual(
		payload.guides
			.map((guide) => guide.provider ?? '')
			.toSorted((a, b) => a.localeCompare(b)),
	)

	const markdown = await callHandler(
		createDocsConnectMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/connect.md'),
			params: { slug: '' },
		},
	)
	expect(markdown.status).toBe(200)
	expect(markdown.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	const body = await markdown.text()
	expect(body.startsWith('#')).toBe(true)
	expect(body).toContain('https://kody.example/docs.md')
	expect(body).toContain('https://kody.example/docs/how-kody-works.md')
	expect(body).toContain('https://kody.example/docs/local-mcp-tunnels.md')
	expect(body).toContain('https://kody.example/docs/locked-mcp-server.md')
	expect(body).toContain('https://kody.example/docs/integration-bootstrap.md')
	for (const guide of listProviderGuides()) {
		expect(body).toContain(`https://kody.example/docs/${guide.slug}.md`)
	}

	// Reserved `connect` is an index route, not a guide detail slug.
	expect(getGuideBySlug('connect')).toBeNull()
	const connectAsDetail = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/connect.md'),
			params: { slug: 'connect' },
		},
	)
	// The dedicated markdown handler is what routers register for
	// `/docs/connect.md`; the detail handler would 404 if somehow matched.
	expect(connectAsDetail.status).toBe(404)
})

test('provider and platform doc markdown details stay stable', async () => {
	const valuesDetail = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/values.md'),
			params: { slug: 'values' },
		},
	)
	expect(valuesDetail.status).toBe(200)
	expect((await valuesDetail.text()).startsWith('#')).toBe(true)

	const detail = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/oauth.md'),
			params: { slug: 'oauth' },
		},
	)
	expect(detail.status).toBe(200)
	expect(detail.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	const detailBody = await detail.text()
	expect(detailBody.startsWith('#')).toBe(true)
	expect(detailBody).not.toContain('\nid: oauth\n')

	const githubMd = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/github.md'),
			params: { slug: 'github' },
		},
	)
	expect(githubMd.status).toBe(200)

	const googleOauthMd = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/google-oauth.md'),
			params: { slug: 'google-oauth' },
		},
	)
	expect(googleOauthMd.status).toBe(200)

	const googleOauthApi = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/google-oauth.json'),
			params: { slug: 'google-oauth' },
		},
	)
	expect(googleOauthApi.status).toBe(200)
	const googleOauthPayload = (await googleOauthApi.json()) as {
		ok: boolean
		slug: string
		id: string
	}
	expect(googleOauthPayload).toMatchObject({
		ok: true,
		slug: 'google-oauth',
		id: 'google_oauth',
	})

	const factoryApi = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/kody-factory.json'),
			params: { slug: 'kody-factory' },
		},
	)
	expect(await factoryApi.json()).toMatchObject({
		ok: true,
		slug: 'kody-factory',
		id: 'kody_factory',
	})

	const missing = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/nope.md'),
			params: { slug: 'nope' },
		},
	)
	expect(missing.status).toBe(404)

	const missingApi = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/nope.json'),
			params: { slug: 'nope' },
		},
	)
	expect(missingApi.status).toBe(404)
})

test('what-is-kody and first-win distinguish chat-model inference from embeddings', async () => {
	const whatIsKody = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/what-is-kody.md'),
			params: { slug: 'what-is-kody' },
		},
	)
	expect(whatIsKody.status).toBe(200)
	const whatIsKodyBody = (await whatIsKody.text()).replace(/\s+/g, ' ')
	expect(whatIsKodyBody).toContain(
		'Kody runs no chat-model agent loop and bills no chat tokens',
	)
	expect(whatIsKodyBody).toContain(
		'Search and indexing use a small embedding model',
	)

	const firstWin = await callHandler(
		createDocDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/first-win.md'),
			params: { slug: 'first-win' },
		},
	)
	expect(firstWin.status).toBe(200)
	const firstWinBody = (await firstWin.text()).replace(/\s+/g, ' ')
	expect(firstWinBody).toContain(
		'it does not run its own chat-model agent loop',
	)
	expect(firstWinBody).toContain('Search indexing uses a small embedding model')
})

test('interactive doc JSON includes walkthrough highlight tokens', async () => {
	const howKodyWorksSnippets = uniqueHighlightSnippets(
		collectHowKodyWorksSnippets(),
	)
	let received: Array<{ code: string; lang?: string | null }> | undefined
	const env = {
		APP_BASE_URL: 'https://kody.example',
		HIGHLIGHT: {
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					snippets: Array<{ code: string; lang?: string | null }>
				}
				received = body.snippets
				return Response.json({
					results: body.snippets.map((snippet) => ({
						code: snippet.code,
						lang: snippet.lang ?? 'plaintext',
						plain: false,
						lines: [
							[
								{
									content: snippet.code,
									style: { color: '#111', '--shiki-dark': '#eee' },
								},
							],
						],
					})),
				})
			},
		} as unknown as Fetcher,
	} as Env

	const howKodyWorksResponse = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/how-kody-works.json'),
			params: { slug: 'how-kody-works' },
		},
	)
	expect(howKodyWorksResponse.status).toBe(200)
	expect(howKodyWorksResponse.headers.get('Cache-Control')).toBe(
		'public, max-age=60, stale-while-revalidate=300',
	)
	expect(howKodyWorksResponse.headers.get('Server-Timing') ?? '').toContain(
		'highlight;dur=',
	)
	const howKodyWorksPayload = (await howKodyWorksResponse.json()) as {
		ok: boolean
		walkthroughHighlights?: Record<
			string,
			{ plain: boolean; lines: Array<Array<{ style?: { color?: string } }>> }
		>
		walkthroughHosts?: WalkthroughHostPick
	}
	expect(howKodyWorksPayload.ok).toBe(true)
	expect(received).toEqual(howKodyWorksSnippets)
	const packageJsonKey = highlightSnippetKey({
		code: howKodyWorksPackageFiles['package.json'],
		lang: 'json',
	})
	expect(
		howKodyWorksPayload.walkthroughHighlights?.[packageJsonKey],
	).toMatchObject({
		plain: false,
		lines: [[{ style: { color: '#111' } }]],
	})
	expect(howKodyWorksPayload.walkthroughHosts).toBeDefined()
	expect(
		isValidWalkthroughHostPick(howKodyWorksPayload.walkthroughHosts!),
	).toBe(true)

	const googleOauthResponse = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/google-oauth.json'),
			params: { slug: 'google-oauth' },
		},
	)
	const googleOauthPayload = (await googleOauthResponse.json()) as {
		walkthroughHighlights?: Record<string, { plain: boolean }>
		walkthroughHosts?: unknown
	}
	const googleOauthKeys = Object.keys(
		googleOauthPayload.walkthroughHighlights ?? {},
	)
	expect(googleOauthKeys.length).toBe(
		uniqueHighlightSnippets(collectGoogleOauthSnippets()).length,
	)
	expect(
		googleOauthKeys.every(
			(key) => googleOauthPayload.walkthroughHighlights?.[key]?.plain === false,
		),
	).toBe(true)
	expect(googleOauthPayload.walkthroughHosts).toBeUndefined()

	const oauthResponse = await callHandler(
		createDocDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/docs/oauth.json'),
			params: { slug: 'oauth' },
		},
	)
	const oauthPayload = (await oauthResponse.json()) as {
		walkthroughHighlights?: Record<string, unknown>
	}
	expect(oauthPayload.walkthroughHighlights).toBeUndefined()
})
