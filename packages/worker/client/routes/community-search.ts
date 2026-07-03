export function readCommunitySearchQueryFromHref(href: string) {
	const url = new URL(href, 'http://localhost')
	return url.searchParams.get('q') ?? ''
}
