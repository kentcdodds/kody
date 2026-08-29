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
	listPlatformGuides,
	listProviderGuides,
	listStartHereGuides,
} from '#worker/guides/catalog.ts'
import {
	buildGuidesConnectMarkdown,
	buildGuidesIndexMarkdown,
	createGuideDetailApiHandler,
	createGuideDetailMarkdownHandler,
	createGuidesApiHandler,
	createGuidesConnectApiHandler,
	createGuidesConnectMarkdownHandler,
	createGuidesMarkdownHandler,
} from './guides.tsx'

const env = { APP_BASE_URL: 'https://kody.example' } as Env

type HandlerArgs = { request: Request; params: { slug: string } }

function callHandler(
	action: { handler: (args: HandlerArgs) => Promise<Response> },
	args: HandlerArgs,
) {
	return action.handler(args)
}

test('guides API and markdown lead with Work with Kody, not the provider dump', async () => {
	const apiResponse = await callHandler(createGuidesApiHandler(env) as never, {
		request: new Request('https://kody.example/guides.json'),
		params: { slug: '' },
	})
	expect(apiResponse.status).toBe(200)
	const payload = (await apiResponse.json()) as {
		ok: boolean
		guides: Array<{ slug: string; id: string; title: string; category: string }>
	}
	expect(payload.ok).toBe(true)
	expect(payload.guides.length).toBe(listPlatformGuides().length)
	expect(payload.guides.every((guide) => guide.category === 'platform')).toBe(
		true,
	)
	expect(payload.guides.some((guide) => guide.id === 'values')).toBe(false)
	expect(payload.guides.some((guide) => guide.slug === 'github')).toBe(false)
	// Bodies stay out of the index payload.
	expect(JSON.stringify(payload)).not.toContain('## ')

	const startHere = listStartHereGuides()
	expect(startHere[0]?.slug).toBe('what-is-kody')
	expect(payload.guides[0]?.slug).toBe(startHere[0]?.slug)

	const markdownIndex = await callHandler(
		createGuidesMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides.md'),
			params: { slug: '' },
		},
	)
	expect(markdownIndex.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	const indexBody = await markdownIndex.text()
	expect(indexBody).toBe(buildGuidesIndexMarkdown('https://kody.example'))
	expect(indexBody.startsWith('#')).toBe(true)
	expect(indexBody.indexOf('## Work with Kody')).toBeLessThan(
		indexBody.indexOf('## Connect a provider'),
	)
	expect(indexBody.indexOf('### Start here')).toBeLessThan(
		indexBody.indexOf('### More guides'),
	)
	expect(indexBody).toContain('https://kody.example/guides/connect.md')
	expect(indexBody).toContain('https://kody.example/guides/what-is-kody.md')
	expect(indexBody).toContain('https://kody.example/guides/how-kody-works.md')
	// Full provider dump stays off the main index.
	expect(indexBody).not.toContain('https://kody.example/guides/github.md')
	expect(indexBody).not.toContain('https://kody.example/guides/discord.md')
	expect(indexBody).not.toContain('https://kody.example/guides/values.md')
	expect(getGuideBySlug('values')?.unadvertised).toBe(true)
})

test('guides connect index serves HTML twins, JSON, and markdown without colliding with guide slugs', async () => {
	const apiResponse = await callHandler(
		createGuidesConnectApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/connect.json'),
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
		payload.guides.map((guide) => guide.provider ?? '').toSorted((a, b) =>
			a.localeCompare(b),
		),
	)

	const markdown = await callHandler(
		createGuidesConnectMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/connect.md'),
			params: { slug: '' },
		},
	)
	expect(markdown.status).toBe(200)
	expect(markdown.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	const body = await markdown.text()
	expect(body).toBe(buildGuidesConnectMarkdown('https://kody.example'))
	expect(body).toContain('# Connect a provider')
	expect(body).toContain('https://kody.example/guides.md')
	expect(body).toContain('https://kody.example/guides/how-kody-works.md')
	expect(body).toContain('https://kody.example/guides/local-mcp-tunnels.md')
	for (const guide of listProviderGuides()) {
		expect(body).toContain(`https://kody.example/guides/${guide.slug}.md`)
	}

	// Reserved `connect` is an index route, not a guide detail slug.
	expect(getGuideBySlug('connect')).toBeNull()
	const connectAsDetail = await callHandler(
		createGuideDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/connect.md'),
			params: { slug: 'connect' },
		},
	)
	// The dedicated markdown handler is what routers register for
	// `/guides/connect.md`; the detail handler would 404 if somehow matched.
	expect(connectAsDetail.status).toBe(404)
})

test('provider and platform guide markdown details stay stable', async () => {
	const valuesDetail = await callHandler(
		createGuideDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/values.md'),
			params: { slug: 'values' },
		},
	)
	expect(valuesDetail.status).toBe(200)
	expect(await valuesDetail.text()).toContain('## Destination map')

	const detail = await callHandler(
		createGuideDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/oauth.md'),
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

	for (const slug of ['github', 'discord', 'google', 'slack'] as const) {
		const providerMd = await callHandler(
			createGuideDetailMarkdownHandler(env) as never,
			{
				request: new Request(`https://kody.example/guides/${slug}.md`),
				params: { slug },
			},
		)
		expect(providerMd.status).toBe(200)
	}

	const googleOauthMd = await callHandler(
		createGuideDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/google-oauth.md'),
			params: { slug: 'google-oauth' },
		},
	)
	expect(googleOauthMd.status).toBe(200)

	const googleOauthApi = await callHandler(
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/google-oauth.json'),
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
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/kody-factory.json'),
			params: { slug: 'kody-factory' },
		},
	)
	expect(await factoryApi.json()).toMatchObject({
		ok: true,
		slug: 'kody-factory',
		id: 'kody_factory',
	})

	const missing = await callHandler(
		createGuideDetailMarkdownHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/nope.md'),
			params: { slug: 'nope' },
		},
	)
	expect(missing.status).toBe(404)

	const missingApi = await callHandler(
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/nope.json'),
			params: { slug: 'nope' },
		},
	)
	expect(missingApi.status).toBe(404)
})

test('interactive guide JSON includes walkthrough highlight tokens', async () => {
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
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/how-kody-works.json'),
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
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/google-oauth.json'),
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
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/oauth.json'),
			params: { slug: 'oauth' },
		},
	)
	const oauthPayload = (await oauthResponse.json()) as {
		walkthroughHighlights?: Record<string, unknown>
	}
	expect(oauthPayload.walkthroughHighlights).toBeUndefined()
})
