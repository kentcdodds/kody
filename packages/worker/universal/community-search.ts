import { routes } from '#universal/routes.ts'

export const communityListingSorts = ['best', 'newest'] as const

export type CommunityListingSort = (typeof communityListingSorts)[number]

export const defaultCommunityListingSort = 'best' satisfies CommunityListingSort

export function parseCommunityListingSort(
	raw: string | null | undefined,
): CommunityListingSort {
	return raw === 'newest' ? 'newest' : defaultCommunityListingSort
}

export function readCommunitySearchFromHref(href: string) {
	const url = new URL(href, 'http://localhost')
	return {
		query: url.searchParams.get('q') ?? '',
		sort: parseCommunityListingSort(url.searchParams.get('sort')),
	}
}

export function readCommunitySearchQueryFromHref(href: string) {
	return readCommunitySearchFromHref(href).query
}

export function buildCommunityIndexHref(input?: {
	query?: string | null
	sort?: CommunityListingSort
}) {
	const searchParams = new URLSearchParams()
	const query = input?.query?.trim() ?? ''
	if (query.length > 0) searchParams.set('q', query)
	if (input?.sort === 'newest') searchParams.set('sort', 'newest')
	return routes.community.href(
		null,
		searchParams.size > 0 ? { searchParams } : undefined,
	)
}
