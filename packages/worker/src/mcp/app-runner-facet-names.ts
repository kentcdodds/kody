const appFacetClassName = 'App'

export function buildFacetName(rawFacetName: string | null | undefined) {
	return rawFacetName?.trim() || 'main'
}

function fnv1a32(input: string): number {
	let hash = 2_166_136_261
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16_777_619)
	}
	return hash >>> 0
}

export function buildFacetClassExportName(facetName: string) {
	const sanitizedFacetName = facetName.replaceAll(/[^a-zA-Z0-9_]/g, '_')
	const hashSuffix = fnv1a32(facetName).toString(16).padStart(8, '0')
	return facetName === 'main'
		? appFacetClassName
		: `${appFacetClassName}_${sanitizedFacetName}_${hashSuffix}`
}
