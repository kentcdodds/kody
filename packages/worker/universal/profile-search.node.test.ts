import { expect, test } from 'vitest'
import {
	buildProfileHref,
	filterProfilePackages,
	isProfilePackageFilterOnlyHrefChange,
	profilePackageFiltersAreActive,
	readProfilePackageFiltersFromHref,
	readProfileSearchQueryFromHref,
} from './profile-search.ts'
import { type PublicProfilePackageItem } from './community-public-types.ts'

const listedApp = {
	name: '@kody/notes-app',
	kodyId: 'notes-app',
	description: 'Notes with a UI.',
	tags: ['notes'],
	updatedAt: '2026-08-01T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityListingKodyId: 'notes-app',
	communityPublishedAt: '2026-07-01T00:00:00.000Z',
	needsRepublish: true,
	hasApp: true,
	webhookCount: 0,
	jobCount: 0,
	isPrivate: false,
	hidden: false,
} satisfies PublicProfilePackageItem

const privateNoApp = {
	name: '@kody/secret',
	kodyId: 'secret',
	description: 'Private helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasApp: false,
	webhookCount: 0,
	jobCount: 0,
	isPrivate: true,
	hidden: true,
} satisfies PublicProfilePackageItem

test('profile package filter hrefs omit defaults and ignore owner-only params for guests', () => {
	expect(buildProfileHref({ username: 'kody' })).toBe('/@kody')
	expect(
		buildProfileHref({
			username: 'kody',
			query: '  notes  ',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'all',
		}),
	).toBe('/@kody?q=notes')
	expect(
		buildProfileHref({
			username: 'kody',
			query: 'notes',
			visibility: 'private',
			listing: 'unpublished',
			hidden: 'yes',
			app: 'yes',
		}),
	).toBe(
		'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=yes',
	)
	expect(
		buildProfileHref({
			username: 'kody',
			listing: 'ahead',
		}),
	).toBe('/@kody?listing=ahead')

	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=no',
			{ allowOwnerFilters: true },
		),
	).toEqual({
		query: 'notes',
		visibility: 'private',
		listing: 'unpublished',
		hidden: 'yes',
		app: 'no',
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
		app: 'all',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?listing=published')).toEqual(
		{
			query: '',
			visibility: 'all',
			listing: 'published',
			hidden: 'all',
			app: 'all',
		},
	)
	expect(readProfilePackageFiltersFromHref('/@kody?app=yes')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'yes',
	})
	expect(readProfileSearchQueryFromHref('/@kody?q=obsidian')).toBe('obsidian')
	expect(
		profilePackageFiltersAreActive({
			query: 'notes',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'all',
		}),
	).toBe(false)
	expect(
		profilePackageFiltersAreActive({
			query: '',
			visibility: 'private',
			listing: 'all',
			hidden: 'all',
			app: 'all',
		}),
	).toBe(true)
	expect(
		profilePackageFiltersAreActive({
			query: '',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'yes',
		}),
	).toBe(true)
})

test('chip-only profile href changes skip the loader; search changes do not', () => {
	expect(
		isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?visibility=private'),
	).toBe(true)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?q=notes',
			'/@kody?q=notes&listing=published&app=yes',
		),
	).toBe(true)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?visibility=private',
			'/@kody?listing=unpublished',
		),
	).toBe(true)
	expect(isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?q=notes')).toBe(
		false,
	)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?q=notes',
			'/@kody?q=notes&limit=10',
		),
	).toBe(false)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody',
			'/@other?visibility=private',
		),
	).toBe(false)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/community',
			'/community?visibility=private',
		),
	).toBe(false)
	expect(isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody')).toBe(false)
})

test('profile package chips filter the already-loaded list', () => {
	const packages = [listedApp, privateNoApp]
	expect(
		filterProfilePackages(packages, {
			query: 'ignored-server-side',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'all',
		}),
	).toEqual(packages)
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'private',
			listing: 'all',
			hidden: 'all',
			app: 'all',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'all',
			listing: 'published',
			hidden: 'all',
			app: 'all',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'all',
			listing: 'ahead',
			hidden: 'all',
			app: 'all',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'all',
			listing: 'all',
			hidden: 'yes',
			app: 'all',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'yes',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			query: '',
			visibility: 'all',
			listing: 'all',
			hidden: 'all',
			app: 'no',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
})
