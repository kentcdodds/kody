/**
 * Phase 2 of issue #3836: seal credential stamps on published packages by
 * declaring stamp keys in `kody.credentials` with inferred descriptions where
 * possible (literal MCP servers, OAuth/integration names, signing keys).
 * Packages with unstampable patterns or uninferable secret descriptions are
 * reported as `needs_manual` for an agent conversion attempt.
 */
import {
	applyCredentialStampSealPlan,
	planCredentialStampSeal,
} from '#worker/credentials/credential-stamp.ts'
import {
	type PackageCodemod,
	type PackageCodemodContext,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const sealCredentialStampsCodemodId = '0014-seal-credential-stamps'

const packageManifestPath = 'package.json'

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const sealCredentialStampsMessages = {
	declare:
		'Uses stamped credentials that kody.credentials does not declare with a description. This codemod fills inferred descriptions (MCP servers, OAuth accounts, signing keys) and leaves other keys for manual review.',
	unconvertible:
		'Has credential patterns the stamp gate cannot seal (non-literal names, |scope=, secretMounts, packageSecrets.get, credential.named, server eval, dynamic kody.mcp, or invalid keys). Convert to literal stamped uses by hand, then republish.',
	uninferable:
		'Has stamped credential keys whose purpose cannot be inferred from source. Write a real description in kody.credentials for each, then republish.',
} as const

function normalizeSnapshotPath(path: string) {
	return path.trim().replace(/^\/+/, '')
}

/**
 * The package's own files keyed as in the snapshot (same locate rules as
 * 0013). Nested packages may arrive keyed from the repo root or from their
 * source root.
 */
function locatePackage(
	files: Record<string, string>,
	context: PackageCodemodContext,
) {
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
		return { files: remapped }
	}
	const relativeManifest = underRoot
		? manifestPath.slice(prefix.length)
		: manifestPath
	const manifestKey = keyFor(relativeManifest) ?? relativeManifest
	if (manifestKey === packageManifestPath) return { files }
	const remapped: Record<string, string> = { ...files }
	if (files[manifestKey] != null) {
		remapped[packageManifestPath] = files[manifestKey]!
	}
	return { files: remapped }
}

function remapSealFilesToSnapshot(
	original: Record<string, string>,
	sealed: Record<string, string>,
	context: PackageCodemodContext,
): Record<string, string> {
	const root = normalizeSnapshotPath(context.sourceRoot ?? '').replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeSnapshotPath(
		context.manifestPath ?? packageManifestPath,
	)
	const prefix = `${root}/`
	const underRoot = root !== '' && manifestPath.startsWith(prefix)
	const next = { ...original }
	const sealedManifest = sealed[packageManifestPath]
	if (sealedManifest == null) return next
	if (underRoot) {
		next[manifestPath] = sealedManifest
		return next
	}
	const relativeManifest =
		root !== '' && manifestPath.startsWith(prefix)
			? manifestPath.slice(prefix.length)
			: manifestPath
	next[relativeManifest] = sealedManifest
	if (relativeManifest !== packageManifestPath) {
		next[packageManifestPath] = sealedManifest
	}
	return next
}

function detectSealCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const located = locatePackage(files, context)
	const plan = planCredentialStampSeal(located.files)
	const findings: Array<PackageCodemodFinding> = []
	if (plan.updates.length > 0) {
		findings.push({
			path: packageManifestPath,
			message: sealCredentialStampsMessages.declare,
		})
	}
	if (plan.blockingFailures.length > 0) {
		findings.push({
			path: plan.blockingFailures[0]?.path ?? null,
			message: sealCredentialStampsMessages.unconvertible,
		})
	}
	if (plan.uninferableKeys.length > 0) {
		findings.push({
			path: packageManifestPath,
			message: sealCredentialStampsMessages.uninferable,
		})
	}
	return findings
}

function transformSealCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const located = locatePackage(files, context)
	const plan = planCredentialStampSeal(located.files)
	const needsManual: Array<PackageCodemodFinding> = []
	if (plan.blockingFailures.length > 0) {
		needsManual.push({
			path: plan.blockingFailures[0]?.path ?? null,
			message: sealCredentialStampsMessages.unconvertible,
		})
	}
	if (plan.uninferableKeys.length > 0) {
		needsManual.push({
			path: packageManifestPath,
			message: sealCredentialStampsMessages.uninferable,
		})
	}
	if (plan.updates.length === 0) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual,
		}
	}
	const applied = applyCredentialStampSealPlan(located.files, plan)
	if (!applied.changed) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual,
		}
	}
	const nextFiles = remapSealFilesToSnapshot(files, applied.files, context)
	const changedPaths = [
		...new Set(
			[
				normalizeSnapshotPath(context.manifestPath ?? packageManifestPath),
				packageManifestPath,
			].filter((path) => nextFiles[path] !== files[path]),
		),
	]
	return {
		files: nextFiles,
		changed: true,
		changedPaths,
		needsManual,
	}
}

/**
 * Fleet seal for issue #3836 phase 2: write inferred `kody.credentials`
 * descriptions for stampable literal uses (including MCP server names), then
 * republish so `storePublishedCredentialStamp` seals the sidecar. packages
 * that still need a human description or cannot be stamped stay
 * `needs_manual`.
 */
export const sealCredentialStampsCodemod: PackageCodemod = {
	id: sealCredentialStampsCodemodId,
	description:
		'Seal credential stamps for published packages: declare missing kody.credentials slots with inferred descriptions for literal MCP servers, OAuth accounts, and signing keys; flag unconvertible patterns and uninferable secret descriptions for manual review (issue #3836 phase 2).',
	applyMode: 'published-only',
	detect: detectSealCredentialStamps,
	transform: transformSealCredentialStamps,
}
