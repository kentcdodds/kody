import { expect, test } from 'vitest'
import { tokenizeSnippet } from './tokenize.ts'

test('tokenizes known languages with dual-theme styles', () => {
	const ts = tokenizeSnippet({ code: 'const secret = "<script>"', lang: 'ts' })
	expect(ts.plain).toBe(false)
	expect(ts.lang).toBe('ts')
	expect(ts.code).toContain('<script>')
	const styles = ts.lines
		.flat()
		.flatMap((span) => Object.values(span.style ?? {}))
	expect(
		styles.some((value) => value.includes('#') || value.startsWith('var')),
	).toBe(true)

	const json = tokenizeSnippet({ code: '{"ok": true}', lang: 'json' })
	expect(json.plain).toBe(false)
	expect(json.lines.flat().some((span) => span.content.includes('ok'))).toBe(
		true,
	)

	const jsAlias = tokenizeSnippet({ code: 'const x = 1', lang: 'js' })
	expect(jsAlias.lang).toBe('ts')
	expect(jsAlias.plain).toBe(false)

	const shell = tokenizeSnippet({
		code: 'npx @kodycodes/cli install',
		lang: 'sh',
	})
	expect(shell.plain).toBe(false)
	expect(shell.lang).toBe('shellscript')

	const golang = tokenizeSnippet({ code: 'package main', lang: 'golang' })
	expect(golang.plain).toBe(false)
	expect(golang.lang).toBe('go')

	const consoleLang = tokenizeSnippet({ code: 'echo hi', lang: 'console' })
	expect(consoleLang.plain).toBe(false)
	expect(consoleLang.lang).toBe('shellscript')
})

test('unknown languages and oversized snippets stay plaintext', () => {
	const unknown = tokenizeSnippet({ code: 'SELECT 1', lang: 'not-a-real-lang' })
	expect(unknown).toEqual({
		code: 'SELECT 1',
		lang: 'not-a-real-lang',
		plain: true,
		lines: [],
	})

	const huge = tokenizeSnippet({
		code: 'x'.repeat(50_001),
		lang: 'ts',
	})
	expect(huge.plain).toBe(true)
	expect(huge.lines).toEqual([])
})
