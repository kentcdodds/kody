import { expect, test } from 'vitest'
import {
	buildCommunityIndexHref,
	parseCommunityListingSort,
	readCommunitySearchFromHref,
	readCommunitySearchQueryFromHref,
} from './community-search.ts'

test('community search hrefs omit default sort and keep newest with the query', () => {
	expect(parseCommunityListingSort(null)).toBe('best')
	expect(parseCommunityListingSort('best')).toBe('best')
	expect(parseCommunityListingSort('bogus')).toBe('best')
	expect(parseCommunityListingSort('newest')).toBe('newest')

	expect(buildCommunityIndexHref()).toBe('/community')
	expect(buildCommunityIndexHref({ sort: 'best' })).toBe('/community')
	expect(buildCommunityIndexHref({ query: '  github  ' })).toBe(
		'/community?q=github',
	)
	expect(buildCommunityIndexHref({ query: 'github', sort: 'newest' })).toBe(
		'/community?q=github&sort=newest',
	)
	expect(buildCommunityIndexHref({ sort: 'newest' })).toBe(
		'/community?sort=newest',
	)

	expect(
		readCommunitySearchFromHref('/community?q=obsidian&sort=newest'),
	).toEqual({
		query: 'obsidian',
		sort: 'newest',
	})
	expect(readCommunitySearchQueryFromHref('/community?q=obsidian')).toBe(
		'obsidian',
	)
})
