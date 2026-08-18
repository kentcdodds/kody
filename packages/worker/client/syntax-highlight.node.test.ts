import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderHighlightedCode as renderHighlightedCodeCore } from '#client/syntax-highlight-core.tsx'
import {
	loadSyntaxHighlight,
	renderHighlightedCode,
	resetSyntaxHighlightLoadForTests,
} from '#client/syntax-highlight.tsx'

test('highlights known languages with dual-theme token styles and escapes content', async () => {
	const tsHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCodeCore('const secret = "<script>"', 'ts'),
		}),
	)
	expect(tsHtml).toContain('class="shiki')
	expect(tsHtml).toContain('--shiki-dark:')
	expect(tsHtml).toContain('const')
	expect(tsHtml).toContain('&lt;script&gt;')
	expect(tsHtml).not.toContain('<script>')

	const jsonHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCodeCore('{"ok": true}', 'json'),
		}),
	)
	expect(jsonHtml).toContain('"ok"')
	expect(jsonHtml).toContain('true')

	const jsAliasHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCodeCore('const x = 1', 'js'),
		}),
	)
	expect(jsAliasHtml).toContain('class="shiki')
	expect(jsAliasHtml).toContain('const')

	const unknownHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCodeCore('SELECT 1', 'not-a-real-lang'),
		}),
	)
	// Unknown langs fall back to plaintext highlighting, still escaped.
	expect(unknownHtml).toContain('class="shiki')
	expect(unknownHtml).toContain('SELECT 1')
})

test('public API falls back to plaintext until the core chunk loads', async () => {
	resetSyntaxHighlightLoadForTests()
	const pendingHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCode('const x = 1', 'ts'),
		}),
	)
	expect(pendingHtml).toContain('class="shiki')
	expect(pendingHtml).toContain('const x = 1')
	expect(pendingHtml).not.toContain('--shiki-dark:')

	await loadSyntaxHighlight()
	const loadedHtml = await renderToString(
		jsx('div', {
			children: renderHighlightedCode('const x = 1', 'ts'),
		}),
	)
	expect(loadedHtml).toContain('--shiki-dark:')
	expect(loadedHtml).toContain('const')
})
