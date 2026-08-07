import { expect, test } from 'vitest'
import {
	createGuideDetailApiHandler,
	createGuideDetailMarkdownHandler,
	createGuidesApiHandler,
	createGuidesMarkdownHandler,
} from './guides.tsx'
import { guides } from '#worker/guides/catalog.ts'

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
	expect(payload.guides.length).toBe(guides.length)
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
	for (const guide of guides) {
		expect(indexBody).toContain(`https://kody.example/guides/${guide.slug}.md`)
	}

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
