import { expect, test, vi } from 'vitest'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import { routes } from '#universal/routes.ts'
import { fetchLandingLoopHighlights } from './landing-loop-highlights.ts'

test('landing loop highlight fetch reads walkthrough tokens from the guide JSON', async () => {
	const snippet = { code: 'const x = 1', lang: 'ts' }
	const key = highlightSnippetKey(snippet)
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		expect(String(input)).toBe(
			routes.guideDetailApi.href({ slug: 'how-kody-works' }),
		)
		return Response.json({
			ok: true,
			walkthroughHighlights: {
				[key]: {
					code: snippet.code,
					lang: snippet.lang,
					plain: false,
					lines: [[{ content: 'const', style: { color: '#d73a49' } }]],
				},
			},
		})
	})
	const originalFetch = globalThis.fetch
	globalThis.fetch = fetchMock as typeof fetch
	try {
		const highlights = await fetchLandingLoopHighlights()
		expect(highlights[key]?.plain).toBe(false)
		expect(highlights[key]?.lines[0]?.[0]?.style?.color).toBe('#d73a49')
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = (async () => {
		throw new Error('offline')
	}) as typeof fetch
	try {
		expect(await fetchLandingLoopHighlights()).toEqual({})
	} finally {
		globalThis.fetch = originalFetch
	}
})
