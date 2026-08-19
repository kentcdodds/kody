import { normalizePackageInvocationExportName } from '@kody-internal/shared/public-urls.ts'

export const packageTokenWildcardExport = '*'

export function tryNormalizePackageTokenExportName(
	exportName: string,
): string | null {
	const trimmed = exportName.trim()
	if (!trimmed) return null
	if (trimmed === packageTokenWildcardExport) {
		return packageTokenWildcardExport
	}
	try {
		return normalizePackageInvocationExportName(trimmed)
	} catch {
		return null
	}
}

export function parsePackageTokenExportSelection(
	values: Array<string>,
): Array<string> {
	const names: Array<string> = []
	for (const value of values) {
		const normalized = tryNormalizePackageTokenExportName(value)
		if (normalized) names.push(normalized)
	}
	if (names.includes(packageTokenWildcardExport)) {
		return [packageTokenWildcardExport]
	}
	return Array.from(new Set(names))
}

export function applyPackageTokenExportSelection(input: {
	current: Array<string>
	exportName: string
	selected: boolean
}): Array<string> {
	const normalized = tryNormalizePackageTokenExportName(input.exportName)
	if (!normalized) return parsePackageTokenExportSelection(input.current)
	if (normalized === packageTokenWildcardExport) {
		return input.selected ? [packageTokenWildcardExport] : []
	}
	const specific = parsePackageTokenExportSelection(input.current).filter(
		(name) => name !== packageTokenWildcardExport && name !== normalized,
	)
	return input.selected ? [...specific, normalized] : specific
}

export function listPackageTokenExportChoices(input: {
	packageExports: Array<string> | null
	selected: Array<string>
}): Array<string> {
	const names = new Set<string>()
	for (const name of [...(input.packageExports ?? []), ...input.selected]) {
		const normalized = tryNormalizePackageTokenExportName(name)
		if (normalized && normalized !== packageTokenWildcardExport) {
			names.add(normalized)
		}
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}

export function listPackageManifestExportNames(
	exports: Record<string, unknown>,
): Array<string> {
	return listPackageTokenExportChoices({
		packageExports: Object.keys(exports),
		selected: [],
	})
}

export function isPackageTokenWildcardSelected(exportNames: Array<string>) {
	return exportNames.includes(packageTokenWildcardExport)
}

export function formatPackageTokenExportChoiceLabel(exportName: string) {
	return exportName === '.' ? '. (root export)' : exportName
}
