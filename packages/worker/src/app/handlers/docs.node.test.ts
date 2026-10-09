import { expect, test, vi } from 'vitest'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import { howKodyWorksPackageFiles } from '#universal/how-kody-works-transcript.ts'
import {
	isValidWalkthroughHostPick,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { getGuideBySlug, listProviderGuides } from '#worker/guides/catalog.ts'
import { listDocsNavSlugs, visibleDocsNav } from '#universal/docs-nav.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	createDocDetailApiHandler,
	createDocDetailHandler,
	createDocDetailMarkdownHandler,
	createDocsApiHandler,
	createDocsConnectApiHandler,
	createDocsConnectMarkdownHandler,
	createDocsMarkdownHandler,
	createLlmsTxtHandler,
} from './docs.tsx'
import { resolveLegacyGuidesLocation } from './legacy-guides-redirect.ts'

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: vi.fn(async () => null),
}))

const env = { APP_BASE_URL: 'https://kody.example' } as Env
const publicCache = 'public, max-age=60, stale-while-revalidate=300'
const markdownType = 'text/markdown; charset=utf-8'

type HandlerArgs = { request: Request; params: { slug: string } }

function call(
	create: (env: Env) => unknown,
	path: string,
	options: { slug?: string; headers?: HeadersInit; env?: Env } = {},
) {
	const action = create(options.env ?? env) as {
		handler: (args: HandlerArgs) => Promise<Response>
	}
	return action.handler({
		request: new Request(`https://kody.example${path}`, {
			headers: options.headers,
		}),
		params: { slug: options.slug ?? '' },
	})
}

function expectOrdered(body: string, markers: Array<string>) {
	const positions = markers.map((marker) => body.indexOf(marker))
	expect(positions.every((position) => position >= 0)).toBe(true)
	expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

function asAdminOnce() {
	vi.mocked(readAuthenticatedAppUser).mockResolvedValueOnce({
		roles: ['admin', 'user'],
	} as never)
}

test('docs API lists every advertised doc by section and the markdown root is intro plus index', async () => {
	const apiResponse = await call(createDocsApiHandler, '/docs.json')
	expect(apiResponse.status).toBe(200)
	expect(apiResponse.headers.get('Cache-Control')).toBe(publicCache)
	expect(apiResponse.headers.get('Vary')).toBe('Cookie')
	const payload = (await apiResponse.json()) as {
		ok: boolean
		intro: string
		sections: Array<{ id: string }>
		guides: Array<{
			slug: string
			id: string
			section: string | null
			audience: string
		}>
	}
	expect(payload.ok).toBe(true)
	expect(payload.intro).toBe('what-is-kody')
	expect(payload.guides.map((guide) => guide.slug)).toEqual(
		listDocsNavSlugs({ includeAdmin: false }),
	)
	expect(payload.guides.filter((guide) => guide.id === 'values')).toEqual([])
	expect(payload.guides.every((guide) => guide.section !== null)).toBe(true)
	expect(payload.sections.map((section) => section.id)).toEqual(
		visibleDocsNav(false).map((section) => section.id),
	)
	expect(payload.guides[0]?.slug).toBe('what-is-kody')
	expect(
		payload.guides.find((guide) => guide.slug === 'onboarding')?.audience,
	).toBe('agents')
	// Bodies stay out of the index payload.
	expect(JSON.stringify(payload)).not.toContain('## ')

	const markdownIndex = await call(createDocsMarkdownHandler, '/docs.md')
	expect(markdownIndex.headers.get('content-type')).toBe(markdownType)
	const indexBody = await markdownIndex.text()
	expect(indexBody).toContain('https://kody.example/llms.txt')
	expect(indexBody).toContain('## Examples')
	expect(indexBody).toContain('/docs/flake-hunter.md')
	expectOrdered(indexBody, ['## Introduction', '## Get started'])
	expectOrdered(indexBody, [
		'/docs/what-is-kody.md',
		'/docs/search-and-execute.md',
		'/docs/how-kody-works.md',
	])
	expectOrdered(indexBody, ['## Concepts', '## Connect a provider'])
	for (const hidden of [
		'https://kody.example/docs/values.md',
		'/docs/admin-events.md',
		'## Admin',
	]) {
		expect(indexBody).not.toContain(hidden)
	}

	const llms = await call(createLlmsTxtHandler, '/llms.txt')
	expect(llms.status).toBe(200)
	expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	expect(llms.headers.get('Cache-Control')).toBe(publicCache)
	expect(llms.headers.get('Vary')).toBe('Cookie')
	const llmsBody = await llms.text()
	expect(llmsBody.startsWith('# Kody\n')).toBe(true)
	expect(llmsBody).not.toContain('/docs/values.md')
	expect(llmsBody).not.toContain('/docs/admin-events.md')
	expectOrdered(llmsBody, [
		'/docs/what-is-kody.md',
		'/docs/search-and-execute.md',
		'/docs/how-kody-works.md',
	])
})

test('legacy /guides URLs resolve to their /docs twins and merged doc slugs 308 on every twin', async () => {
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

	const slug = 'integration-backed-app-happy-path'
	for (const [create, ext] of [
		[createDocDetailApiHandler, 'json'],
		[createDocDetailMarkdownHandler, 'md'],
	] as const) {
		const response = await call(create, `/docs/${slug}.${ext}`, { slug })
		expect(response.status).toBe(308)
		expect(response.headers.get('Location')).toBe(`/docs/package-apps.${ext}`)
	}
})

test('docs connect index serves JSON and markdown without colliding with doc slugs', async () => {
	const apiResponse = await call(
		createDocsConnectApiHandler,
		'/docs/connect.json',
	)
	expect(apiResponse.status).toBe(200)
	const payload = (await apiResponse.json()) as {
		ok: boolean
		guides: Array<{ slug: string; category: string; provider: string | null }>
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

	const markdown = await call(
		createDocsConnectMarkdownHandler,
		'/docs/connect.md',
	)
	expect(markdown.status).toBe(200)
	expect(markdown.headers.get('content-type')).toBe(markdownType)
	const body = await markdown.text()
	expect(body.startsWith('#')).toBe(true)
	const linked = [
		'docs',
		'docs/how-kody-works',
		'docs/local-mcp-tunnels',
		'docs/locked-mcp-server',
		'docs/integration-bootstrap',
		...listProviderGuides().map((guide) => `docs/${guide.slug}`),
	].map((path) => `https://kody.example/${path}.md`)
	expect(linked.filter((url) => !body.includes(url))).toEqual([])

	// Reserved `connect` is an index route, not a guide detail slug. The
	// dedicated markdown handler is what routers register for
	// `/docs/connect.md`; the detail handler would 404 if somehow matched.
	expect(getGuideBySlug('connect')).toBeNull()
	expect(
		(
			await call(createDocDetailMarkdownHandler, '/docs/connect.md', {
				slug: 'connect',
			})
		).status,
	).toBe(404)
})

test('provider and platform doc markdown details stay stable', async () => {
	const markdownDetail = (slug: string) =>
		call(createDocDetailMarkdownHandler, `/docs/${slug}.md`, { slug })
	const apiDetail = (slug: string) =>
		call(createDocDetailApiHandler, `/docs/${slug}.json`, { slug })

	for (const slug of ['values', 'oauth', 'github', 'google-oauth']) {
		expect([slug, (await markdownDetail(slug)).status]).toEqual([slug, 200])
	}
	const valuesBody = await (await markdownDetail('values')).text()
	expect(valuesBody.startsWith('#')).toBe(true)
	const oauthDetail = await markdownDetail('oauth')
	expect(oauthDetail.headers.get('content-type')).toBe(markdownType)
	const oauthBody = await oauthDetail.text()
	expect(oauthBody.startsWith('#')).toBe(true)
	expect(oauthBody).not.toContain('\nid: oauth\n')

	const googleOauthApi = await apiDetail('google-oauth')
	expect(googleOauthApi.status).toBe(200)
	expect(await googleOauthApi.json()).toMatchObject({
		ok: true,
		slug: 'google-oauth',
		id: 'google_oauth',
	})
	expect(await (await apiDetail('kody-factory')).json()).toMatchObject({
		ok: true,
		slug: 'kody-factory',
		id: 'kody_factory',
	})

	expect((await markdownDetail('nope')).status).toBe(404)
	expect((await apiDetail('nope')).status).toBe(404)
})

test('interactive doc JSON includes walkthrough highlight tokens', async () => {
	let received: Array<{ code: string; lang?: string | null }> | undefined
	const highlightEnv = {
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
	const apiDetail = (slug: string) =>
		call(createDocDetailApiHandler, `/docs/${slug}.json`, {
			slug,
			env: highlightEnv,
		})

	const howKodyWorksResponse = await apiDetail('how-kody-works')
	expect(howKodyWorksResponse.status).toBe(200)
	expect(howKodyWorksResponse.headers.get('Cache-Control')).toBe(publicCache)
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
	expect(received?.length).toBeGreaterThan(0)
	const packageJsonKey = highlightSnippetKey({
		code: howKodyWorksPackageFiles['package.json'],
		lang: 'json',
	})
	expect(
		howKodyWorksPayload.walkthroughHighlights?.[packageJsonKey],
	).toMatchObject({ plain: false, lines: [[{ style: { color: '#111' } }]] })
	expect(howKodyWorksPayload.walkthroughHosts).toBeDefined()
	expect(
		isValidWalkthroughHostPick(howKodyWorksPayload.walkthroughHosts!),
	).toBe(true)

	const googleOauthPayload = (await (
		await apiDetail('google-oauth')
	).json()) as {
		walkthroughHighlights?: Record<string, { plain: boolean }>
		walkthroughHosts?: unknown
	}
	const googleOauthHighlights = Object.values(
		googleOauthPayload.walkthroughHighlights ?? {},
	)
	expect(googleOauthHighlights.length).toBeGreaterThan(0)
	expect(googleOauthHighlights.every((entry) => entry.plain === false)).toBe(
		true,
	)
	expect(googleOauthPayload.walkthroughHosts).toBeUndefined()

	const oauthPayload = (await (await apiDetail('oauth')).json()) as {
		walkthroughHighlights?: Record<string, unknown>
	}
	expect(oauthPayload.walkthroughHighlights).toBeUndefined()
})

test('admin-only docs 404 for anonymous viewers and stay out of public subscriptions', async () => {
	const slug = 'admin-events'
	const json = await call(createDocDetailApiHandler, `/docs/${slug}.json`, {
		slug,
	})
	expect(json.status).toBe(404)
	expect(await json.json()).toEqual({ ok: false, error: 'Doc not found.' })
	const markdown = await call(
		createDocDetailMarkdownHandler,
		`/docs/${slug}.md`,
		{ slug },
	)
	expect(markdown.status).toBe(404)
	expect(await markdown.text()).toBe('# Doc not found\n')

	const publicSubscriptions = await call(
		createDocDetailMarkdownHandler,
		'/docs/package-subscriptions.md',
		{ slug: 'package-subscriptions' },
	)
	expect(publicSubscriptions.status).toBe(200)
	expect(await publicSubscriptions.text()).toContain('run.error.recorded')

	const cookie = { Cookie: 'kody_session=test' }
	asAdminOnce()
	const adminJson = await call(
		createDocDetailApiHandler,
		`/docs/${slug}.json`,
		{
			slug,
			headers: cookie,
		},
	)
	expect(adminJson.status).toBe(200)
	expect(adminJson.headers.get('Cache-Control')).toBe('no-store')
	expect(await adminJson.json()).toMatchObject({
		ok: true,
		slug,
		body: expect.stringContaining('fleet.entitlement.crossed'),
	})

	asAdminOnce()
	const adminMarkdown = await call(
		createDocDetailMarkdownHandler,
		`/docs/${slug}.md`,
		{ slug, headers: cookie },
	)
	expect(adminMarkdown.status).toBe(200)
	expect(adminMarkdown.headers.get('Cache-Control')).toBe('no-store')
	expect(await adminMarkdown.text()).toContain('fleet.entitlement.crossed')

	asAdminOnce()
	const adminNegotiated = await call(createDocDetailHandler, `/docs/${slug}`, {
		slug,
		headers: { ...cookie, Accept: 'text/markdown' },
	})
	expect(adminNegotiated.status).toBe(200)
	expect(adminNegotiated.headers.get('Cache-Control')).toBe('no-store')
	expect(adminNegotiated.headers.get('Vary')).toBe('Accept')
	expect(await adminNegotiated.text()).toContain('fleet.entitlement.crossed')

	asAdminOnce()
	const adminIndex = await call(createDocsApiHandler, '/docs.json', {
		headers: cookie,
	})
	expect(adminIndex.status).toBe(200)
	expect(adminIndex.headers.get('Cache-Control')).toBe('no-store')
	const adminIndexPayload = (await adminIndex.json()) as {
		guides: Array<{ slug: string }>
		sections: Array<{ id: string }>
	}
	expect(adminIndexPayload.guides.some((guide) => guide.slug === slug)).toBe(
		true,
	)
	expect(
		adminIndexPayload.sections.some((section) => section.id === 'admin'),
	).toBe(true)
})
