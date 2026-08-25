import { expect, test } from 'vitest'
import {
	collectMarkdownFences,
	highlightJsonValue,
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { highlightCacheHeaderName } from '#universal/highlight-cache-header.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

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

test('highlightSnippets covers fallback, worker timings, key mapping, and worker errors', async () => {
	const fallbackTiming: Array<ServerTimingEntry> = []
	const fallback = await highlightSnippets(
		{},
		[{ code: 'const x = 1', lang: 'ts' }],
		{ serverTiming: fallbackTiming },
	)
	expect(fallback).toEqual([plainHighlightedCode('const x = 1', 'ts')])
	expect(fallbackTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'fallback' }),
	])

	const snippet = { code: 'const x = 1', lang: 'ts' as const }
	const fixture = highlightedFixture(snippet.code)
	const workerTiming: Array<ServerTimingEntry> = []
	const workerEnv = {
		HIGHLIGHT: {
			fetch: async () =>
				Response.json(
					{ results: [fixture] },
					{ headers: { [highlightCacheHeaderName]: 'hit' } },
				),
		} as unknown as Fetcher,
	}
	const workerResults = await highlightSnippets(workerEnv, [snippet], {
		serverTiming: workerTiming,
	})
	expect(workerResults).toEqual([fixture])
	expect(workerTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'worker' }),
	])
	expect(highlightResultsByKey([snippet], workerResults)).toEqual({
		[highlightSnippetKey(snippet)]: fixture,
	})
	expect(
		uniqueHighlightSnippets([snippet, snippet, { code: 'x', lang: 'txt' }]),
	).toEqual([snippet, { code: 'x', lang: 'txt' }])

	const missTiming: Array<ServerTimingEntry> = []
	const missEnv = {
		HIGHLIGHT: {
			fetch: async () =>
				Response.json(
					{ results: [fixture] },
					{ headers: { [highlightCacheHeaderName]: 'miss' } },
				),
		} as unknown as Fetcher,
	}
	expect(
		await highlightSnippets(missEnv, [snippet], { serverTiming: missTiming }),
	).toEqual([fixture])
	expect(missTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'miss' }),
	])

	const errorEnv = {
		HIGHLIGHT: {
			fetch: async () => new Response('nope', { status: 503 }),
		} as unknown as Fetcher,
	}
	expect(
		await highlightSnippets(errorEnv, [{ code: 'const x = 1', lang: 'ts' }]),
	).toEqual([plainHighlightedCode('const x = 1', 'ts')])
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
