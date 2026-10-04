/**
 * Product invariant: the platform never mounts third-party modules into a
 * package bundle. Bundler file sets may only include node_modules paths that
 * already exist in the package snapshot (publish-time install). Do not grow a
 * vendor denylist — refuse any injected node_modules path.
 */
export function assertNoPlatformSuppliedNodeModules(input: {
	snapshotFiles: Record<string, string>
	bundlerFiles: Record<string, string>
	bundleLabel: string
}) {
	const injected = Object.keys(input.bundlerFiles)
		.filter(
			(filePath) =>
				filePath.startsWith('node_modules/') &&
				!(filePath in input.snapshotFiles),
		)
		.sort((left, right) => left.localeCompare(right))
	if (injected.length === 0) return
	const preview = injected
		.slice(0, 8)
		.map((path) => `"${path}"`)
		.join(', ')
	const more = injected.length > 8 ? ` (and ${injected.length - 8} more)` : ''
	throw new Error(
		`${input.bundleLabel} includes node_modules paths the package snapshot does not contain (${preview}${more}). Kody does not supply third-party modules to package bundles; declare and install dependencies in the package instead.`,
	)
}

export function listNodeModulesPackageRoots(
	files: Record<string, string>,
): Array<string> {
	const roots = new Set<string>()
	for (const filePath of Object.keys(files)) {
		if (!filePath.startsWith('node_modules/')) continue
		const rest = filePath.slice('node_modules/'.length)
		const segments = rest.split('/')
		if (segments[0]?.startsWith('@') && segments.length >= 2) {
			roots.add(`${segments[0]}/${segments[1]}`)
			continue
		}
		if (segments[0]) roots.add(segments[0])
	}
	return [...roots].sort((left, right) => left.localeCompare(right))
}
