/**
 * Repo/list identity mark paths. Canonical file is `.kody/icon.png`; other
 * `.kody/icon.*` extensions, root `icon.*`, and root `community-icon.*` are
 * permanent aliases. Package apps may fall back to `icons/icon-192.png`.
 *
 * Within each group the first existing file wins: svg, png, webp, jpg, jpeg.
 */

export const identityIconExtensions = [
	'svg',
	'png',
	'webp',
	'jpg',
	'jpeg',
] as const

export type IdentityIconExtension = (typeof identityIconExtensions)[number]

function iconPathsForStem(stem: string) {
	return identityIconExtensions.map(
		(extension) => `${stem}.${extension}` as const,
	)
}

export const kodyIdentityIconPaths = iconPathsForStem('.kody/icon')
export const legacyRootIconPaths = iconPathsForStem('icon')
export const legacyCommunityIconPaths = iconPathsForStem('community-icon')
export const packageAppIdentityIconPath = 'icons/icon-192.png' as const

export const identityIconAliasPaths = [
	...kodyIdentityIconPaths,
	...legacyRootIconPaths,
	...legacyCommunityIconPaths,
] as const

export const identityIconSourcePaths = [
	...identityIconAliasPaths,
	packageAppIdentityIconPath,
] as const

export type IdentityIconSourcePath = (typeof identityIconSourcePaths)[number]

export function isIdentityIconSourcePath(
	path: string,
): path is IdentityIconSourcePath {
	return identityIconSourcePaths.some((candidate) => candidate === path)
}

export function isSnapshotRetainedIdentityIconPath(path: string) {
	return isIdentityIconSourcePath(path) && path.endsWith('.svg')
}

/**
 * Text-backed community snapshots keep SVG list marks and the package-app
 * PWA file. Raster aliases are stripped so forks do not ingest corrupted
 * UTF-8 bytes. `icons/icon-192.png` stays so a listing fork still has its
 * app icon even when a `.kody/icon` / root mark is the catalog identity.
 */
export function shouldStripIdentityIconFromCommunitySnapshot(path: string) {
	return (
		isIdentityIconSourcePath(path) &&
		!path.endsWith('.svg') &&
		path !== packageAppIdentityIconPath
	)
}

export function findIdentityIconPath(
	files: Readonly<Record<string, string>>,
	options?: { includePackageAppIcon?: boolean },
): IdentityIconSourcePath | null {
	const paths = options?.includePackageAppIcon
		? identityIconSourcePaths
		: identityIconAliasPaths
	return paths.find((path) => path in files) ?? null
}

export {
	identityIconLeafName,
	identityIconMonogramLetter,
} from '#universal/identity-icon-leaf.ts'
