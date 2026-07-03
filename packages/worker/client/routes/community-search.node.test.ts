import { expect, test } from 'vitest'
import { readCommunitySearchQueryFromHref } from './community-search.ts'

test('readCommunitySearchQueryFromHref returns q param', () => {
	expect(
		readCommunitySearchQueryFromHref(
			'http://localhost:3742/community?q=github',
		),
	).toBe('github')
})

test('readCommunitySearchQueryFromHref returns empty string when q is missing', () => {
	expect(
		readCommunitySearchQueryFromHref('http://localhost:3742/community'),
	).toBe('')
})
