import { expect, test } from 'vitest'
import {
	groupCommunityListingsByCategory,
	inferCommunityListingCategoryFromTags,
	parseCommunityListingCategory,
	parseCommunityPackageCategory,
	resolveCommunityListingCategory,
} from './community-categories.ts'

test('community categories parse a closed set and resolve from tags when unset', () => {
	expect(parseCommunityListingCategory('Integrations')).toBe('integrations')
	expect(parseCommunityListingCategory('other')).toBe('other')
	expect(parseCommunityListingCategory('bogus')).toBeNull()
	expect(parseCommunityPackageCategory('other')).toBeNull()
	expect(parseCommunityPackageCategory('apps')).toBe('apps')

	expect(inferCommunityListingCategoryFromTags(['github', 'issues'])).toBe(
		'integrations',
	)
	expect(inferCommunityListingCategoryFromTags(['zero-auth', 'github'])).toBe(
		'examples',
	)
	expect(
		inferCommunityListingCategoryFromTags(['meal', 'grocery', 'planning']),
	).toBe('productivity')
	expect(inferCommunityListingCategoryFromTags(['unrelated'])).toBeNull()

	expect(
		resolveCommunityListingCategory({
			category: 'utilities',
			tags: ['github'],
		}),
	).toBe('utilities')
	expect(
		resolveCommunityListingCategory({
			category: 'other',
			tags: ['discord'],
		}),
	).toBe('integrations')
	expect(resolveCommunityListingCategory({ tags: [] })).toBe('other')

	const grouped = groupCommunityListingsByCategory(
		[
			{ id: '1', category: 'integrations' as const },
			{ id: '2', category: 'integrations' as const },
			{ id: '3', category: 'examples' as const },
			{ id: '4', category: 'other' as const },
		],
		1,
	)
	expect(
		grouped.map((group) => [group.category, group.total, group.listings]),
	).toEqual([
		['integrations', 2, [{ id: '1', category: 'integrations' }]],
		['examples', 1, [{ id: '3', category: 'examples' }]],
		['other', 1, [{ id: '4', category: 'other' }]],
	])
})
