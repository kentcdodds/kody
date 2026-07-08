import { fnv1a32Hex } from '@kody-internal/shared/fnv1a.ts'

const appFacetClassName = 'App'

export function buildFacetName(rawFacetName: string | null | undefined) {
	return rawFacetName?.trim() || 'main'
}

export function buildFacetClassExportName(facetName: string) {
	const canonicalName = buildFacetName(facetName)
	const sanitizedFacetName = canonicalName.replaceAll(/[^a-zA-Z0-9_]/g, '_')
	const hashSuffix = fnv1a32Hex(canonicalName)
	return canonicalName === 'main'
		? appFacetClassName
		: `${appFacetClassName}_${sanitizedFacetName}_${hashSuffix}`
}
