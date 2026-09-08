import { routes } from '#universal/routes.ts'
import {
	isReservedPackageFilesKodyId,
	joinPackageFilesPath,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'

export const packageReadmeImageMaxBytes = 2 * 1024 * 1024

const packageReadmeImageExtensions = [
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'svg',
] as const

const packageReadmeImageExtensionSet = new Set<string>(
	packageReadmeImageExtensions,
)

function extensionOfPath(path: string) {
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	if (separator <= 0 || separator === name.length - 1) return ''
	return name.slice(separator + 1).toLowerCase()
}

/** True when the repo-relative path is a README-servable image file. */
export function isPackageReadmeImagePath(path: string) {
	return packageReadmeImageExtensionSet.has(extensionOfPath(path))
}

/**
 * Directory that owns a file path (`docs/README.md` → `docs`). Empty for a
 * root file so `./poster.png` stays at the package root.
 */
export function directoryOfPackageFilePath(path: string | null | undefined) {
	if (!path) return ''
	const lastSlash = path.lastIndexOf('/')
	return lastSlash === -1 ? '' : path.slice(0, lastSlash)
}

/**
 * Resolve a markdown image href against a package file directory.
 * Only in-repo relative paths with an allowlisted image extension pass.
 * Protocols, `//`, query/hash, and `..` traversal fail closed.
 */
export function resolvePackageReadmeImagePath(
	href: string,
	fromDirectory = '',
): string | null {
	const trimmed = href.trim()
	if (!trimmed) return null
	if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(trimmed)) return null
	if (trimmed.startsWith('//')) return null
	if (trimmed.includes('?') || trimmed.includes('#')) return null
	const combined = trimmed.startsWith('/')
		? trimmed
		: fromDirectory
			? `${fromDirectory}/${trimmed}`
			: trimmed
	const normalized = normalizePackageFilesPath(combined)
	if (!normalized || !isPackageReadmeImagePath(normalized)) return null
	return normalized
}

export function getCommunityPackageAssetHref(input: {
	listingId?: string | null
	ownerUsername?: string | null
	kodyId?: string | null
	relativePath?: string
}) {
	const relativePath = input.relativePath?.trim() || undefined
	if (
		input.ownerUsername &&
		input.kodyId &&
		!isReservedPackageFilesKodyId(input.kodyId)
	) {
		return relativePath
			? routes.communityPackageAsset.href({
					username: input.ownerUsername,
					kodyId: input.kodyId,
					relativePath,
				})
			: routes.communityPackageAsset.href({
					username: input.ownerUsername,
					kodyId: input.kodyId,
				})
	}
	const listingId = input.listingId?.trim()
	if (!listingId) return null
	return relativePath
		? routes.communityDetailAsset.href({
				listingId,
				relativePath,
			})
		: routes.communityDetailAsset.href({ listingId })
}

/** Prefix used as `imageBaseHref` for README markdown in this package. */
export function getCommunityPackageAssetBaseHref(input: {
	listingId?: string | null
	ownerUsername?: string | null
	kodyId?: string | null
}) {
	return getCommunityPackageAssetHref(input)
}

/**
 * `/assets/` only reads the published or pinned blob. Opt in to `<img>`
 * only when the markdown being viewed is that same revision, including
 * abbreviated SHA prefixes used by tree URLs.
 */
export function packageReadmeAssetCommitMatchesView(
	viewedCommit: string | null | undefined,
	assetCommit: string | null | undefined,
) {
	const viewed = viewedCommit?.trim() ?? ''
	const asset = assetCommit?.trim() ?? ''
	if (!viewed || !asset) return false
	return (
		viewed === asset || viewed.startsWith(asset) || asset.startsWith(viewed)
	)
}

/** Asset prefix when the viewed tree commit is the published/pinned one. */
export function getCommunityPackageAssetBaseHrefForViewedCommit(input: {
	listingId?: string | null
	ownerUsername?: string | null
	kodyId?: string | null
	viewedCommit?: string | null
	assetCommit?: string | null
}) {
	if (
		!packageReadmeAssetCommitMatchesView(input.viewedCommit, input.assetCommit)
	) {
		return null
	}
	return getCommunityPackageAssetBaseHref(input)
}

export function joinPackageReadmeImageHref(
	imageBaseHref: string,
	relativePath: string,
) {
	return joinPackageFilesPath(imageBaseHref, relativePath)
}
