import { expect, test } from 'vitest'
import {
	buildProfileHref,
	profilePackageFiltersAreActive,
	readProfilePackageFiltersFromHref,
	readProfileSearchQueryFromHref,
} from './profile-search.ts'

test('profile package filter hrefs omit defaults and ignore owner-only params for guests', () => {
	expect(buildProfileHref({ username: 'kody' })).toBe('/@kody')
	expect(
		buildProfileHref({
			username: 'kody',
			query: '  notes  ',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
		}),
	).toBe('/@kody?q=notes')
	expect(
		buildProfileHref({
			username: 'kody',
			query: 'notes',
			visibility: 'private',
			listing: 'unpublished',
			hidden: 'yes',
		}),
	).toBe('/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes')
	expect(
		buildProfileHref({
			username: 'kody',
			listing: 'ahead',
		}),
	).toBe('/@kody?listing=ahead')

	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes',
			{ allowOwnerFilters: true },
		),
	).toEqual({
		query: 'notes',
		visibility: 'private',
		listing: 'unpublished',
		hidden: 'yes',
	})
	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?visibility=private&listing=ahead&hidden=yes',
		),
	).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?listing=published')).toEqual(
		{
			query: '',
			visibility: 'all',
			listing: 'published',
			hidden: 'all',
		},
	)
	expect(readProfileSearchQueryFromHref('/@kody?q=obsidian')).toBe('obsidian')
	expect(
		profilePackageFiltersAreActive({
			query: 'notes',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
		}),
	).toBe(false)
	expect(
		profilePackageFiltersAreActive({
			query: '',
			visibility: 'private',
			listing: 'all',
			hidden: 'all',
		}),
	).toBe(true)
})
