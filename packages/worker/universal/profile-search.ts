import { routes } from '#universal/routes.ts'
import {
	type ProfilePackageAppFilter,
	type ProfilePackageFilters,
	type ProfilePackageHiddenFilter,
	type ProfilePackageListingFilter,
	type ProfilePackageVisibilityFilter,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'
import { isProfilePathname } from '#universal/profile-path.ts'

const defaultProfilePackageFilters = {
	query: '',
	visibility: 'all',
	listing: 'all',
	hidden: 'all',
	app: 'all',
} as const satisfies ProfilePackageFilters

const profilePackageChipParams = [
	'visibility',
	'listing',
	'hidden',
	'app',
] as const

function parseVisibility(
	raw: string | null | undefined,
): ProfilePackageVisibilityFilter {
	return raw === 'public' || raw === 'private' ? raw : 'all'
}

function parseListing(
	raw: string | null | undefined,
): ProfilePackageListingFilter {
	return raw === 'published' || raw === 'unpublished' || raw === 'ahead'
		? raw
		: 'all'
}

function parseHidden(
	raw: string | null | undefined,
): ProfilePackageHiddenFilter {
	return raw === 'yes' || raw === 'no' ? raw : 'all'
}

function parseApp(raw: string | null | undefined): ProfilePackageAppFilter {
	return raw === 'yes' || raw === 'no' ? raw : 'all'
}

export function readProfilePackageFiltersFromUrl(
	url: URL,
	options?: { allowOwnerFilters?: boolean },
): ProfilePackageFilters {
	const allowOwnerFilters = options?.allowOwnerFilters === true
	const listing = parseListing(url.searchParams.get('listing'))
	return {
		query: url.searchParams.get('q')?.trim() ?? '',
		visibility: allowOwnerFilters
			? parseVisibility(url.searchParams.get('visibility'))
			: 'all',
		listing:
			allowOwnerFilters || listing !== 'ahead'
				? listing
				: defaultProfilePackageFilters.listing,
		hidden: allowOwnerFilters
			? parseHidden(url.searchParams.get('hidden'))
			: 'all',
		app: parseApp(url.searchParams.get('app')),
	}
}

export function readProfilePackageFiltersFromHref(
	href: string,
	options?: { allowOwnerFilters?: boolean },
): ProfilePackageFilters {
	return readProfilePackageFiltersFromUrl(
		new URL(href, 'http://localhost'),
		options,
	)
}

export function readProfileSearchQueryFromHref(href: string) {
	return readProfilePackageFiltersFromHref(href).query
}

export function profilePackageFiltersAreActive(filters: ProfilePackageFilters) {
	return (
		filters.visibility !== 'all' ||
		filters.listing !== 'all' ||
		filters.hidden !== 'all' ||
		filters.app !== 'all'
	)
}

export function buildProfileHref(input: {
	username: string
	query?: string | null
	visibility?: ProfilePackageVisibilityFilter
	listing?: ProfilePackageListingFilter
	hidden?: ProfilePackageHiddenFilter
	app?: ProfilePackageAppFilter
}) {
	const searchParams = new URLSearchParams()
	const query = input.query?.trim() ?? ''
	if (query.length > 0) searchParams.set('q', query)
	if (input.visibility === 'public' || input.visibility === 'private') {
		searchParams.set('visibility', input.visibility)
	}
	if (
		input.listing === 'published' ||
		input.listing === 'unpublished' ||
		input.listing === 'ahead'
	) {
		searchParams.set('listing', input.listing)
	}
	if (input.hidden === 'yes' || input.hidden === 'no') {
		searchParams.set('hidden', input.hidden)
	}
	if (input.app === 'yes' || input.app === 'no') {
		searchParams.set('app', input.app)
	}
	return routes.profile.href(
		{ username: input.username },
		searchParams.size > 0 ? { searchParams } : undefined,
	)
}

function hrefWithoutChipParams(href: string) {
	const url = new URL(href, 'http://localhost')
	for (const param of profilePackageChipParams) {
		url.searchParams.delete(param)
	}
	url.searchParams.sort()
	return `${url.pathname}?${url.searchParams.toString()}${url.hash}`
}

/**
 * True when both URLs are the same `/@username` page and only chip filters
 * (`visibility`, `listing`, `hidden`, `app`) differ. Search (`q`) and every
 * other query param stay the same, so the already-loaded package list can
 * be re-filtered without a loader or frame fetch.
 */
export function isProfilePackageFilterOnlyHrefChange(from: string, to: string) {
	const fromUrl = new URL(from, 'http://localhost')
	const toUrl = new URL(to, 'http://localhost')
	if (fromUrl.pathname !== toUrl.pathname) return false
	if (!isProfilePathname(fromUrl.pathname)) return false
	if (fromUrl.search === toUrl.search) return false
	return hrefWithoutChipParams(from) === hrefWithoutChipParams(to)
}

function matchesVisibility(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageVisibilityFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'public':
			return pkg.isPrivate !== true
		case 'private':
			return pkg.isPrivate === true
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile visibility filter: ${exhaustive}`)
		}
	}
}

function matchesHidden(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageHiddenFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'yes':
			return pkg.hidden === true
		case 'no':
			return pkg.hidden !== true
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile hidden filter: ${exhaustive}`)
		}
	}
}

function matchesListing(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageListingFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'published':
			return pkg.communityListingId != null
		case 'unpublished':
			return pkg.communityListingId == null
		case 'ahead':
			return pkg.needsRepublish
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile listing filter: ${exhaustive}`)
		}
	}
}

function matchesApp(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageAppFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'yes':
			return pkg.hasApp
		case 'no':
			return !pkg.hasApp
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile app filter: ${exhaustive}`)
		}
	}
}

export function profilePackageMatchesFilters(
	pkg: PublicProfilePackageItem,
	filters: ProfilePackageFilters,
) {
	return (
		matchesVisibility(pkg, filters.visibility) &&
		matchesHidden(pkg, filters.hidden) &&
		matchesListing(pkg, filters.listing) &&
		matchesApp(pkg, filters.app)
	)
}

export function filterProfilePackages(
	packages: ReadonlyArray<PublicProfilePackageItem>,
	filters: ProfilePackageFilters,
) {
	if (!profilePackageFiltersAreActive(filters)) return [...packages]
	return packages.filter((pkg) => profilePackageMatchesFilters(pkg, filters))
}
