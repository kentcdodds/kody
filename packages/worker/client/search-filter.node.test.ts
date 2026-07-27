import { expect, test } from 'vitest'
import { matchesSearchQuery } from './search-filter.ts'

test('search query matching ignores case, spans fields, and requires every token', () => {
	const values = ['GitHub OAuth', 'github-oauth', 'api.github.com', null]

	expect(matchesSearchQuery('', values)).toBe(true)
	expect(matchesSearchQuery('GITHUB', values)).toBe(true)
	expect(matchesSearchQuery('oauth api.github', values)).toBe(true)
	expect(matchesSearchQuery('github spotify', values)).toBe(false)
})
