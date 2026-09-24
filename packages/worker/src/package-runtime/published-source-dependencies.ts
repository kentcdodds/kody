import { collectBundlerResolvedSpecifiers } from './import-specifiers.ts'

const packageManifestPath = 'package.json'
const scriptSourcePathPattern = /\.(?:[cm]?[jt]sx?)$/i

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

function isInstalledDependencyPath(path: string) {
	const normalized = path.replace(/^\.?\//, '')
	return normalized === 'node_modules' || normalized.startsWith('node_modules/')
}

function npmPackageNameFromSpecifier(specifier: string) {
	if (
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		specifier.startsWith('#') ||
		specifier.startsWith('node:') ||
		specifier.startsWith('cloudflare:') ||
		specifier.startsWith('kody:')
	) {
		return null
	}
	if (specifier.startsWith('@')) {
		const [scope, name] = specifier.split('/')
		if (!scope || !name) return null
		return `${scope}/${name}`
	}
	const name = specifier.split('/')[0]
	return name || null
}

/**
 * True when every bare import in the snapshot already has its package on
 * disk. Unparseable scripts fail closed. `devDependencies` are included,
 * because a published artifact can contain a module the source imports even
 * when `dependencies` is empty.
 */
export function publishedSourceBareImportsAreInstalled(
	sourceFiles: Record<string, string>,
) {
	for (const [path, source] of Object.entries(sourceFiles)) {
		if (isInstalledDependencyPath(path) || path.endsWith('.d.ts')) continue
		if (!scriptSourcePathPattern.test(path)) continue
		const specifiers = collectBundlerResolvedSpecifiers(source)
		if (specifiers == null) return false
		for (const specifier of specifiers) {
			const packageName = npmPackageNameFromSpecifier(specifier)
			if (!packageName) continue
			if (sourceFiles[`node_modules/${packageName}/package.json`] == null) {
				return false
			}
		}
	}
	return true
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
