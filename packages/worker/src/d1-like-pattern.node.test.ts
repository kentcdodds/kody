import { expect, test } from 'vitest'
import {
	d1ContainsLikePattern,
	d1MaxLikePatternBytes,
	escapeLikePattern,
} from './d1-like-pattern.ts'

const byteLength = (value: string) => new TextEncoder().encode(value).length

test('short queries are escaped and wrapped in wildcards', () => {
	expect(d1ContainsLikePattern('kody')).toBe('%kody%')
	expect(d1ContainsLikePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%')
	expect(d1ContainsLikePattern('a_b', { escape: false })).toBe('%a_b%')
	expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\')
})

test('long queries are trimmed to fit the D1 pattern limit', () => {
	const stableUserId = 'f'.repeat(64)
	const pattern = d1ContainsLikePattern(`"${stableUserId}"`)
	expect(byteLength(pattern)).toBeLessThanOrEqual(d1MaxLikePatternBytes)
	expect(pattern.startsWith('%"f')).toBe(true)
	expect(pattern.endsWith('%')).toBe(true)

	const emoji = d1ContainsLikePattern('🙂'.repeat(40))
	expect(byteLength(emoji)).toBeLessThanOrEqual(d1MaxLikePatternBytes)
	// Never split a multi-byte character.
	expect(emoji).toMatch(/^%(🙂)*%$/u)

	// A 45-byte ASCII prefix followed by a supplementary character: the trim
	// lands inside the surrogate pair and must drop the whole code point.
	const surrogateEdge = d1ContainsLikePattern(`${'a'.repeat(45)}🙂🙂`)
	expect(surrogateEdge).toBe(`%${'a'.repeat(45)}%`)
	expect(surrogateEdge.isWellFormed()).toBe(true)
})

test('trimming never leaves a dangling escape before the closing wildcard', () => {
	// 47 characters then an escaped percent: the trim lands right after the
	// backslash, which must be dropped along with its escaped character.
	const value = `${'a'.repeat(47)}%`
	const pattern = d1ContainsLikePattern(value)
	expect(byteLength(pattern)).toBeLessThanOrEqual(d1MaxLikePatternBytes)
	expect(pattern).toBe(`%${'a'.repeat(47)}%`)
	expect(pattern.endsWith('\\%')).toBe(false)
})
