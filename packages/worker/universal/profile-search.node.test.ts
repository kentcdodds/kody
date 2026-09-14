import { expect, test } from 'vitest'
import {
	buildProfileHref,
	filterProfilePackages,
	isProfilePackageFilterOnlyHrefChange,
	profilePackageFiltersAreActive,
	profilePackageSortIsActive,
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
	iconUrl: null,
	isPrivate: false,
	hidden: false,
} satisfies PublicProfilePackageItem

const privateNoApp = {
	name: '@kody/aardvark',
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
	iconUrl: null,
	isPrivate: true,
	hidden: true,
} satisfies PublicProfilePackageItem

const privateListed = {
	...listedApp,
	name: '@kody/secret-app',
	kodyId: 'secret-app',
	isPrivate: true,
	hidden: false,
	needsRepublish: false,
} satisfies PublicProfilePackageItem

const defaultFilters = {
	query: '',
	visibility: 'all',
	listing: 'all',
	hidden: 'all',
	app: 'all',
	sort: 'updated',
} as const

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
			sort: 'updated',
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
			sort: 'name',
		}),
	).toBe(
		'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=yes&sort=name',
	)
	expect(
		buildProfileHref({
			username: 'kody',
			listing: 'ahead',
		}),
	).toBe('/@kody?listing=ahead')

	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=no&sort=name',
			{ allowOwnerFilters: true },
		),
	).toEqual({
		query: 'notes',
		visibility: 'private',
		listing: 'unpublished',
		hidden: 'yes',
		app: 'no',
		sort: 'name',
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
		sort: 'updated',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?listing=published')).toEqual(
		{
			query: '',
			visibility: 'all',
			listing: 'published',
			hidden: 'all',
			app: 'all',
			sort: 'updated',
		},
	)
	expect(readProfilePackageFiltersFromHref('/@kody?app=yes')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'yes',
		sort: 'updated',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?sort=name')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		sort: 'name',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?sort=bogus')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		sort: 'updated',
	})
	expect(readProfileSearchQueryFromHref('/@kody?q=obsidian')).toBe('obsidian')
	expect(
		profilePackageFiltersAreActive({
			query: 'notes',
			...defaultFilters,
		}),
	).toBe(false)
	expect(
		profilePackageFiltersAreActive({
			...defaultFilters,
			visibility: 'private',
		}),
	).toBe(true)
	expect(
		profilePackageFiltersAreActive({
			...defaultFilters,
			app: 'yes',
		}),
	).toBe(true)
	expect(
		profilePackageFiltersAreActive({ ...defaultFilters, sort: 'name' }),
	).toBe(false)
	expect(profilePackageSortIsActive('updated')).toBe(false)
	expect(profilePackageSortIsActive('name')).toBe(true)
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
	expect(
		isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?sort=name'),
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
			...defaultFilters,
		}),
	).toEqual(packages)
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			visibility: 'private',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			listing: 'published',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			listing: 'ahead',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			hidden: 'yes',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			app: 'yes',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			app: 'no',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			listing: 'unpublished',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	const inventory = [listedApp, privateNoApp, privateListed]
	expect(
		filterProfilePackages(inventory, {
			...defaultFilters,
			listing: 'unpublished',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(inventory, {
			...defaultFilters,
			listing: 'published',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret-app'])
})

test('profile package sort reorders the already-loaded list without changing default order', () => {
	const packages = [listedApp, privateNoApp]
	expect(
		filterProfilePackages(packages, defaultFilters).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret'])
	expect(
		filterProfilePackages(packages, { ...defaultFilters, sort: 'name' }).map(
			(pkg) => pkg.kodyId,
		),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages([privateNoApp, listedApp], {
			...defaultFilters,
			sort: 'name',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages([privateNoApp, listedApp], defaultFilters).map(
			(pkg) => pkg.kodyId,
		),
	).toEqual(['secret', 'notes-app'])
})
