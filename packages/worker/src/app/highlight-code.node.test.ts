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

test('highlightSnippets records fallback, worker, miss, and origin-hit timings', async () => {
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
	expect(
		await highlightSnippets(workerEnv, [snippet], {
			serverTiming: workerTiming,
		}),
	).toEqual([fixture])
	expect(workerTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'worker' }),
	])

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
	expect(
		uniqueHighlightSnippets([snippet, snippet, { code: 'x', lang: 'txt' }]),
	).toEqual([snippet, { code: 'x', lang: 'txt' }])
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
