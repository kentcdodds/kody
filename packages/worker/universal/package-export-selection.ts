import { normalizePackageInvocationExportName } from '@kody-internal/shared/public-urls.ts'

function tryNormalizePackageExportName(exportName: string): string | null {
	const trimmed = exportName.trim()
	if (!trimmed || trimmed === '*') return null
	try {
		return normalizePackageInvocationExportName(trimmed)
	} catch {
		return null
	}
}

/**
 * Normalized export names from a package manifest, excluding `*`.
 */
export function listPackageManifestExportNames(
	exports: Record<string, unknown>,
): Array<string> {
	const names = new Set<string>()
	for (const name of Object.keys(exports)) {
		const normalized = tryNormalizePackageExportName(name)
		if (normalized) names.add(normalized)
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}
