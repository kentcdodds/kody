export function readProfileSearchQueryFromHref(href: string) {
	const url = new URL(href, 'http://localhost')
	return url.searchParams.get('q') ?? ''
}
