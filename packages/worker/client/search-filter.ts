export function matchesSearchQuery(
	query: string,
	searchableValues: ReadonlyArray<string | null | undefined>,
) {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return true

	const haystack = searchableValues
		.filter((value): value is string => typeof value === 'string')
		.join(' ')
		.toLocaleLowerCase()

	return tokens.every((token) => haystack.includes(token))
}
