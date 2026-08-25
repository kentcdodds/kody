import { expect, test } from 'vitest'
import { highlightSnippetKey } from './highlighted-code.ts'

test('highlight snippet keys keep lang and code fields distinct', () => {
	expect(
		highlightSnippetKey({ lang: 'ts', code: 'const x: number = 1' }),
	).not.toBe(highlightSnippetKey({ lang: 'ts:const x', code: ' number = 1' }))
	expect(highlightSnippetKey({ lang: 'ts', code: 'const x = 1' })).toBe(
		highlightSnippetKey({ lang: 'TS', code: 'const x = 1' }),
	)
})
