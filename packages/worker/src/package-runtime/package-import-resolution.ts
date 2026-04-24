import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

export const packageSpecifierPrefix = 'kody:@'

export type KodyPackageSpecifier = {
	packageName: string
	kodyId: string
	exportName: string
}

const kodyImportLiteralPattern = /['"](kody:@[^'"]+)['"]/g

function unsupportedSpecifierError(specifier: string) {
	return new Error(`Unsupported Kody package specifier "${specifier}".`)
}

export function parseKodyPackageSpecifier(
	specifier: string,
): KodyPackageSpecifier {
	if (!specifier.startsWith(packageSpecifierPrefix)) {
		throw unsupportedSpecifierError(specifier)
	}

	const trimmed = specifier.slice(packageSpecifierPrefix.length).trim()
	if (!trimmed) {
		throw unsupportedSpecifierError(specifier)
	}

	const scopeSeparator = trimmed.indexOf('/')
	if (scopeSeparator <= 1) {
		throw unsupportedSpecifierError(specifier)
	}

	const exportSeparator = trimmed.indexOf('/', scopeSeparator + 1)
	const packageName =
		exportSeparator === -1
			? trimmed
			: trimmed.slice(0, exportSeparator).trim()
	const kodyId =
		exportSeparator === -1
			? trimmed.slice(scopeSeparator + 1).trim()
			: trimmed.slice(scopeSeparator + 1, exportSeparator).trim()

	if (!packageName || !kodyId) {
		throw unsupportedSpecifierError(specifier)
	}

	return {
		packageName,
		kodyId,
		exportName:
			exportSeparator === -1
				? '.'
				: trimmed.slice(exportSeparator + 1).trim() || '.',
	}
}

export function collectKodyPackageImportSpecifiers(source: string) {
	const specifiers: Array<KodyPackageSpecifier> = []
	for (const match of source.matchAll(kodyImportLiteralPattern)) {
		const specifier = match[1]?.trim()
		if (!specifier?.startsWith(packageSpecifierPrefix)) {
			continue
		}
		specifiers.push(parseKodyPackageSpecifier(specifier))
	}
	return specifiers
}

export async function resolveSavedPackageImport(input: {
	db: D1Database
	userId: string
	specifier: string | KodyPackageSpecifier
}): Promise<SavedPackageRecord | null> {
	const parsed =
		typeof input.specifier === 'string'
			? parseKodyPackageSpecifier(input.specifier)
			: input.specifier

	return await getSavedPackageByName(input.db, {
		userId: input.userId,
		name: parsed.packageName,
	})
}
