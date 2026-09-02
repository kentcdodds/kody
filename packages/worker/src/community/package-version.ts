const maxPackageManifestVersionLength = 64

export function normalizePackageManifestVersion(
	value: string | null | undefined,
): string | null {
	if (value == null) return null
	const trimmed = value.trim()
	if (
		trimmed.length === 0 ||
		trimmed.length > maxPackageManifestVersionLength ||
		/\s/.test(trimmed)
	) {
		return null
	}
	return trimmed
}

/**
 * Read `package.json#version` as display metadata. The platform does not
 * version packages (decision 0001); this is the author-supplied label when
 * they set a string.
 */
export function readPackageManifestVersion(
	content: string | null | undefined,
): string | null {
	if (content == null || content.trim() === '') return null
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		return null
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null
	}
	const version = Reflect.get(parsed, 'version')
	if (typeof version !== 'string') return null
	return normalizePackageManifestVersion(version)
}

export function resolveListingPackageVersion(input: {
	stored?: string | null
	packageJson?: string | null
}): string | null {
	return (
		normalizePackageManifestVersion(input.stored) ??
		readPackageManifestVersion(input.packageJson)
	)
}
