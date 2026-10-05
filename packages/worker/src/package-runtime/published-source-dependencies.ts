const packageManifestPath = 'package.json'

export const publishedRuntimeBundleMissingMessage =
	'no published runtime bundle artifact is available yet'

/** How long invoke may serve the previous npm bundle after published_commit flips. */
export const publishedNpmBundleRebuildWindowMs = 2 * 60 * 1000

export function isPublishedSourceWithinNpmBundleRebuildWindow(input: {
	publishedAt: string | null | undefined
	nowMs?: number
}) {
	const publishedAtMs = Date.parse(input.publishedAt ?? '')
	if (!Number.isFinite(publishedAtMs)) return false
	return (
		(input.nowMs ?? Date.now()) - publishedAtMs <=
		publishedNpmBundleRebuildWindowMs
	)
}

function getDeclaredPackageDependencies(sourceFiles: Record<string, string>) {
	const packageJson = sourceFiles[packageManifestPath]
	if (!packageJson) return []
	try {
		const parsed = JSON.parse(packageJson) as {
			dependencies?: Record<string, string>
		}
		return Object.keys(parsed.dependencies ?? {}).sort((left, right) =>
			left.localeCompare(right),
		)
	} catch {
		return []
	}
}

function getMissingInstalledDependencies(input: {
	sourceFiles: Record<string, string>
	dependencies: Array<string>
}) {
	return input.dependencies.filter(
		(dependencyName) =>
			input.sourceFiles[`node_modules/${dependencyName}/package.json`] == null,
	)
}

export function listMissingPublishedSourceInstalledDependencies(
	sourceFiles: Record<string, string>,
) {
	const dependencies = getDeclaredPackageDependencies(sourceFiles)
	if (dependencies.length === 0) return []
	return getMissingInstalledDependencies({
		sourceFiles,
		dependencies,
	})
}

export function isPublishedRuntimeBundleMissingError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes(publishedRuntimeBundleMissingMessage)
	)
}

export function assertPublishedSourceCanRebuildWithoutInstallingDeps(input: {
	sourceFiles: Record<string, string>
	bundleLabel: string
}) {
	const missingDependencies = listMissingPublishedSourceInstalledDependencies(
		input.sourceFiles,
	)
	if (missingDependencies.length === 0) return
	throw new Error(
		`${input.bundleLabel} declares npm dependencies (${missingDependencies
			.map((dependency) => `"${dependency}"`)
			.join(
				', ',
			)}) but ${publishedRuntimeBundleMissingMessage}. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.`,
	)
}
