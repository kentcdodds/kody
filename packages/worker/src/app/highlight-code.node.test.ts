import { expect, test } from 'vitest'
import {
	collectMarkdownFences,
	highlightJsonValue,
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
} from '#app/highlight-code.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'

function highlightedFixture(
	code: string,
	lang = 'typescript',
): HighlightedCode {
	return {
		code,
		lang,
		plain: false,
		lines: [
			[{ content: code, style: { color: '#111', '--shiki-dark': '#eee' } }],
		],
	}
}

test('collectMarkdownFences walks top-level and nested code tokens', () => {
	expect(
		collectMarkdownFences(
			['# Title', '', '```ts', 'const x = 1', '```', '', '- item', ''].join(
				'\n',
			),
		),
	).toEqual([{ code: 'const x = 1', lang: 'ts' }])

	expect(
		collectMarkdownFences(
			['> quote', '', '> ```json', '> {"ok": true}', '> ```'].join('\n'),
		),
	).toEqual([{ code: '{"ok": true}', lang: 'json' }])
})

test('highlightSnippets falls back to plaintext when HIGHLIGHT is missing', async () => {
	const results = await highlightSnippets({}, [
		{ code: 'const x = 1', lang: 'ts' },
	])
	expect(results).toEqual([plainHighlightedCode('const x = 1', 'ts')])
})

test('highlightSnippets returns worker tokens and maps them by snippet key', async () => {
	const snippet = { code: 'const x = 1', lang: 'ts' as const }
	const fixture = highlightedFixture(snippet.code)
	const env = {
		HIGHLIGHT: {
			fetch: async () =>
				Response.json({
					results: [fixture],
				}),
		} as unknown as Fetcher,
	}
	const results = await highlightSnippets(env, [snippet])
	expect(results).toEqual([fixture])
	expect(highlightResultsByKey([snippet], results)).toEqual({
		[highlightSnippetKey(snippet)]: fixture,
	})
})

test('highlightSnippets falls back when the worker errors', async () => {
	const env = {
		HIGHLIGHT: {
			fetch: async () => new Response('nope', { status: 503 }),
		} as unknown as Fetcher,
	}
	const results = await highlightSnippets(env, [
		{ code: 'const x = 1', lang: 'ts' },
	])
	expect(results).toEqual([plainHighlightedCode('const x = 1', 'ts')])
})

test('highlightMarkdownFences and highlightJsonValue use the worker', async () => {
	const markdownFixture = highlightedFixture('const x = 1')
	const jsonFixture = highlightedFixture('{\n  "ok": true\n}', 'json')
	let calls = 0
	const env = {
		HIGHLIGHT: {
			fetch: async () => {
				calls += 1
				return Response.json({
					results: calls === 1 ? [markdownFixture] : [jsonFixture],
				})
			},
		} as unknown as Fetcher,
	}
	expect(await highlightMarkdownFences(env, '```ts\nconst x = 1\n```')).toEqual(
		[markdownFixture],
	)
	expect(await highlightJsonValue(env, { ok: true })).toEqual(jsonFixture)
})
