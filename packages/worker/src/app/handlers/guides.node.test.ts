import { expect, test } from 'vitest'
import { uniqueHighlightSnippets } from '#app/highlight-code.ts'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import {
	collectHowKodyWorksSnippets,
	howKodyWorksPackageFiles,
} from '#universal/how-kody-works-transcript.ts'
import { collectGoogleOauthSnippets } from '#universal/google-oauth-transcript.ts'
import { getGuideBySlug, listGuides } from '#worker/guides/catalog.ts'
import {
	createGuideDetailApiHandler,
	createGuideDetailMarkdownHandler,
	createGuidesApiHandler,
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

test('guides API, markdown index, and markdown detail serve the bundled catalog', async () => {
	const apiResponse = await callHandler(createGuidesApiHandler(env) as never, {
		request: new Request('https://kody.example/guides.json'),
		params: { slug: '' },
	})
	expect(apiResponse.status).toBe(200)
	const payload = (await apiResponse.json()) as {
		ok: boolean
		guides: Array<{ slug: string; id: string; title: string }>
	}
	expect(payload.ok).toBe(true)
	expect(payload.guides.length).toBe(listGuides().length)
	expect(payload.guides.some((guide) => guide.id === 'values')).toBe(false)
	// Bodies stay out of the index payload.
	expect(JSON.stringify(payload)).not.toContain('## ')

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
	expect(indexBody.startsWith('#')).toBe(true)
	for (const guide of listGuides()) {
		expect(indexBody).toContain(`https://kody.example/guides/${guide.slug}.md`)
	}
	expect(indexBody).not.toContain('https://kody.example/guides/values.md')
	expect(getGuideBySlug('values')?.unadvertised).toBe(true)

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
	// The markdown twin serves the authored body (heading included, no
	// frontmatter fence).
	expect(detailBody.startsWith('#')).toBe(true)
	expect(detailBody).not.toContain('\nid: oauth\n')

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
	const howKodyWorksPayload = (await howKodyWorksResponse.json()) as {
		ok: boolean
		walkthroughHighlights?: Record<
			string,
			{ plain: boolean; lines: Array<Array<{ style?: { color?: string } }>> }
		>
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

	const googleOauthResponse = await callHandler(
		createGuideDetailApiHandler(env) as never,
		{
			request: new Request('https://kody.example/guides/google-oauth.json'),
			params: { slug: 'google-oauth' },
		},
	)
	const googleOauthPayload = (await googleOauthResponse.json()) as {
		walkthroughHighlights?: Record<string, { plain: boolean }>
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
