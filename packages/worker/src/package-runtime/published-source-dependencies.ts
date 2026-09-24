const packageManifestPath = 'package.json'

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

export function canRebuildPublishedSourceWithoutInstallingDeps(
	sourceFiles: Record<string, string>,
) {
	const dependencies = getDeclaredPackageDependencies(sourceFiles)
	if (dependencies.length === 0) return true
	return (
		getMissingInstalledDependencies({
			sourceFiles,
			dependencies,
		}).length === 0
	)
}

export function assertPublishedSourceCanRebuildWithoutInstallingDeps(input: {
	sourceFiles: Record<string, string>
	bundleLabel: string
}) {
	if (canRebuildPublishedSourceWithoutInstallingDeps(input.sourceFiles)) return
	const dependencies = getDeclaredPackageDependencies(input.sourceFiles)
	const missingDependencies = getMissingInstalledDependencies({
		sourceFiles: input.sourceFiles,
		dependencies,
	})
	throw new Error(
		`${input.bundleLabel} declares npm dependencies (${missingDependencies
			.map((dependency) => `"${dependency}"`)
			.join(
				', ',
			)}) but no published runtime bundle artifact is available yet. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.`,
	)
}
