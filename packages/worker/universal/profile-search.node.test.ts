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
	createdAt: '2026-06-01T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityListingKodyId: 'notes-app',
	communityPublishedAt: '2026-07-01T00:00:00.000Z',
	needsRepublish: true,
	hasPackage: true,
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
	createdAt: '2026-04-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasPackage: false,
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
	package: 'all',
	sort: 'updated',
	dir: 'desc',
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
			package: 'all',
			sort: 'updated',
			dir: 'desc',
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
			package: 'no',
			sort: 'name',
			dir: 'desc',
		}),
	).toBe(
		'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=yes&package=no&sort=name&dir=desc',
	)
	expect(
		buildProfileHref({
			username: 'kody',
			listing: 'ahead',
		}),
	).toBe('/@kody?listing=ahead')
	expect(
		buildProfileHref({
			username: 'kody',
			query: 'notes',
			extraSearchParams: new URLSearchParams('limit=10&q=old'),
		}),
	).toBe('/@kody?q=notes&limit=10')

	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=no&package=yes&sort=name&dir=desc',
			{ allowOwnerFilters: true },
		),
	).toEqual({
		query: 'notes',
		visibility: 'private',
		listing: 'unpublished',
		hidden: 'yes',
		app: 'no',
		package: 'yes',
		sort: 'name',
		dir: 'desc',
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
		package: 'all',
		sort: 'updated',
		dir: 'desc',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?listing=published')).toEqual(
		{
			query: '',
			visibility: 'all',
			listing: 'published',
			hidden: 'all',
			app: 'all',
			package: 'all',
			sort: 'updated',
			dir: 'desc',
		},
	)
	expect(readProfilePackageFiltersFromHref('/@kody?app=yes')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'yes',
		package: 'all',
		sort: 'updated',
		dir: 'desc',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?package=no')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		package: 'no',
		sort: 'updated',
		dir: 'desc',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?sort=name')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		package: 'all',
		sort: 'name',
		dir: 'asc',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?sort=created')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		package: 'all',
		sort: 'created',
		dir: 'desc',
	})
	expect(
		readProfilePackageFiltersFromHref('/@kody?sort=updated&dir=asc'),
	).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		package: 'all',
		sort: 'updated',
		dir: 'asc',
	})
	expect(readProfilePackageFiltersFromHref('/@kody?sort=bogus')).toEqual({
		query: '',
		visibility: 'all',
		listing: 'all',
		hidden: 'all',
		app: 'all',
		package: 'all',
		sort: 'updated',
		dir: 'desc',
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
	expect(profilePackageSortIsActive({ sort: 'updated', dir: 'desc' })).toBe(
		false,
	)
	expect(profilePackageSortIsActive({ sort: 'name', dir: 'asc' })).toBe(true)
	expect(profilePackageSortIsActive({ sort: 'updated', dir: 'asc' })).toBe(true)
	expect(profilePackageSortIsActive({ sort: 'created', dir: 'desc' })).toBe(
		true,
	)
	expect(
		profilePackageFiltersAreActive({
			...defaultFilters,
			package: 'no',
		}),
	).toBe(true)
})

test('chip and search profile href changes skip the loader', () => {
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
	expect(
		isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?package=no'),
	).toBe(true)
	expect(isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?dir=asc')).toBe(
		true,
	)
	expect(isProfilePackageFilterOnlyHrefChange('/@kody', '/@kody?q=notes')).toBe(
		true,
	)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?q=notes',
			'/@kody?q=obsidian&visibility=private',
		),
	).toBe(true)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?q=notes',
			'/@kody?q=notes&limit=10',
		),
	).toBe(false)
	expect(
		isProfilePackageFilterOnlyHrefChange(
			'/@kody?limit=10',
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
	expect(filterProfilePackages(packages, defaultFilters)).toEqual(packages)
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
			package: 'yes',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			package: 'no',
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

test('profile search filters the already-loaded list by name, description, tags, and kody id', () => {
	const packages = [listedApp, privateNoApp]
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'notes',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'NOTES UI',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'secret',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'private helper',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'notes',
			visibility: 'private',
		}).map((pkg) => pkg.kodyId),
	).toEqual([])
	expect(
		filterProfilePackages([listedApp, privateNoApp, privateListed], {
			...defaultFilters,
			query: 'secret',
			visibility: 'private',
			listing: 'unpublished',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'zzzz-no-match',
		}),
	).toEqual([])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: 'notes helper',
		}),
	).toEqual([])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			query: '   ',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret'])
})

test('profile package sort reorders the already-loaded list without changing default order', () => {
	const packages = [listedApp, privateNoApp]
	expect(
		filterProfilePackages(packages, defaultFilters).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			sort: 'name',
			dir: 'asc',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages([privateNoApp, listedApp], {
			...defaultFilters,
			sort: 'name',
			dir: 'asc',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages([privateNoApp, listedApp], defaultFilters).map(
			(pkg) => pkg.kodyId,
		),
	).toEqual(['notes-app', 'secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			sort: 'created',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			sort: 'created',
			dir: 'asc',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			sort: 'updated',
			dir: 'asc',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['secret', 'notes-app'])
	expect(
		filterProfilePackages(packages, {
			...defaultFilters,
			sort: 'name',
			dir: 'desc',
		}).map((pkg) => pkg.kodyId),
	).toEqual(['notes-app', 'secret'])
})
