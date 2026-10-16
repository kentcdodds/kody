/**
 * Platform migration for issue #3836: convert published packages to
 * stamp-sealable fixed credential slots when it can be proven safe, then let
 * adminCredentialStampBackfill / adminCredentialStampMigrate stamp them.
 *
 * Holdouts, unconvertible patterns, and uninferable descriptions are
 * needs_manual skips — never owner contact, never credential value changes.
 */
import {
	convertCredentialStampFiles,
	credentialStampConvertCodemodId,
	credentialStampConvertMessages,
} from '#worker/credentials/credential-stamp-convert.ts'
import {
	type PackageCodemod,
	type PackageCodemodContext,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export {
	credentialStampConvertCodemodId as convertCredentialStampsCodemodId,
	credentialStampConvertMessages as convertCredentialStampsMessages,
}

const packageManifestPath = 'package.json'

function normalizeSnapshotPath(path: string) {
	return path.trim().replace(/^\/+/, '')
}

function locatePackage(
	files: Record<string, string>,
	context: PackageCodemodContext,
): {
	files: Record<string, string>
	manifestWriteKey: string
	/** Snapshot path prefix for remapping package-relative module paths back. */
	snapshotPrefix: string
} {
	const root = normalizeSnapshotPath(context.sourceRoot ?? '').replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeSnapshotPath(
		context.manifestPath ?? packageManifestPath,
	)
	const prefix = `${root}/`
	const keyFor = (path: string) =>
		Object.keys(files).find((key) => normalizeSnapshotPath(key) === path)
	const underRoot = root !== '' && manifestPath.startsWith(prefix)
	const repoKey = keyFor(manifestPath)
	if (underRoot && repoKey !== undefined) {
		const scoped = Object.fromEntries(
			Object.entries(files).filter(([key]) =>
				normalizeSnapshotPath(key).startsWith(prefix),
			),
		)
		const remapped: Record<string, string> = {}
		for (const [key, value] of Object.entries(scoped)) {
			const relative = normalizeSnapshotPath(key).slice(prefix.length)
			remapped[relative === '' ? packageManifestPath : relative] = value
		}
		if (remapped[packageManifestPath] == null && scoped[repoKey] != null) {
			remapped[packageManifestPath] = scoped[repoKey]!
		}
		return {
			files: remapped,
			manifestWriteKey: repoKey,
			snapshotPrefix: root,
		}
	}
	const relativeManifest = underRoot
		? manifestPath.slice(prefix.length)
		: manifestPath
	const manifestKey = keyFor(relativeManifest) ?? relativeManifest
	if (manifestKey === packageManifestPath) {
		return {
			files,
			manifestWriteKey: packageManifestPath,
			snapshotPrefix: '',
		}
	}
	const remapped: Record<string, string> = { ...files }
	if (files[manifestKey] != null) {
		remapped[packageManifestPath] = files[manifestKey]!
	}
	return {
		files: remapped,
		manifestWriteKey: manifestKey,
		snapshotPrefix: '',
	}
}

function remapConvertFilesToSnapshot(
	original: Record<string, string>,
	converted: Record<string, string>,
	manifestWriteKey: string,
	snapshotPrefix: string,
): Record<string, string> {
	const next = { ...original }
	const prefix = snapshotPrefix === '' ? '' : `${snapshotPrefix}/`
	for (const [path, content] of Object.entries(converted)) {
		if (path === packageManifestPath) {
			next[manifestWriteKey] = content
			continue
		}
		next[`${prefix}${path}`] = content
	}
	return next
}

function detectConvertCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const located = locatePackage(files, context)
	const result = convertCredentialStampFiles({
		files: located.files,
		packageName: context.packageName,
	})
	if (result.skippedHoldout) {
		return [{ path: null, message: credentialStampConvertMessages.holdout }]
	}
	if (!result.sealReady) {
		return result.needsManual
	}
	if (result.changed) {
		return [
			{
				path: packageManifestPath,
				message:
					'Convertible to sealed credential stamps (literal |scope=package strip, allowlisted missing deps, and/or inferred kody.credentials descriptions).',
			},
		]
	}
	return []
}

function transformConvertCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const located = locatePackage(files, context)
	const result = convertCredentialStampFiles({
		files: located.files,
		packageName: context.packageName,
	})
	if (!result.changed || !result.sealReady) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: result.needsManual,
		}
	}
	const nextFiles = remapConvertFilesToSnapshot(
		files,
		result.files,
		located.manifestWriteKey,
		located.snapshotPrefix,
	)
	const changedPaths = Object.keys(nextFiles)
		.filter((path) => nextFiles[path] !== files[path])
		.sort((left, right) => left.localeCompare(right))
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual: [],
	}
}

/**
 * Conservative conversion for issue #3836: strip literal `|scope=package`,
 * declare allowlisted missing bare deps (e.g. remix), seal stamp descriptions,
 * skip holdouts and anything still unconvertible.
 */
export const convertCredentialStampsCodemod: PackageCodemod = {
	id: credentialStampConvertCodemodId,
	description:
		'Convert published packages to sealed credential stamps when safe: strip literal |scope=package placeholders, declare allowlisted missing bare deps (remix), and fill inferred kody.credentials descriptions. Skips Kent holdouts and packages that still need an owner/API change (issue #3836).',
	applyMode: 'published-only',
	detect: detectConvertCredentialStamps,
	transform: transformConvertCredentialStamps,
}
