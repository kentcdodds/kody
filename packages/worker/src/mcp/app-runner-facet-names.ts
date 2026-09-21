export function buildFacetName(rawFacetName: string | null | undefined) {
	return rawFacetName?.trim() || 'main'
}
