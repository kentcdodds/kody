import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

export const packageSpecifierPrefix = 'kody:@'

export type KodyPackageSpecifier = {
	packageName: string
	exportName: string
}

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

	const segments = trimmed.split('/').map((segment) => segment.trim())
	if (segments.length < 2 || segments[0] === '' || segments[1] === '') {
		throw unsupportedSpecifierError(specifier)
	}

	const scope = segments[0]
	const packageLeaf = segments[1]
	if (!scope || !packageLeaf) {
		throw unsupportedSpecifierError(specifier)
	}

	const packageName = `@${scope}/${packageLeaf}`
	const exportName = segments.slice(2).join('/').trim() || '.'

	return {
		packageName,
		exportName,
	}
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
