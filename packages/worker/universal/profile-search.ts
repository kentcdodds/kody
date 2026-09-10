import { routes } from '#universal/routes.ts'
import {
	type ProfilePackageFilters,
	type ProfilePackageHiddenFilter,
	type ProfilePackageListingFilter,
	type ProfilePackageVisibilityFilter,
} from '#universal/community-public-types.ts'

const defaultProfilePackageFilters = {
	query: '',
	visibility: 'all',
	listing: 'all',
	hidden: 'all',
} as const satisfies ProfilePackageFilters

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
		filters.hidden !== 'all'
	)
}

export function buildProfileHref(input: {
	username: string
	query?: string | null
	visibility?: ProfilePackageVisibilityFilter
	listing?: ProfilePackageListingFilter
	hidden?: ProfilePackageHiddenFilter
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
	return routes.profile.href(
		{ username: input.username },
		searchParams.size > 0 ? { searchParams } : undefined,
	)
}
