import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import {
	collectReachableSourceFilePaths,
	isBundlerRootConfigPath,
	isBundlerRootDependencyPath,
	readRootPackage,
} from './module-graph-workspace.ts'

/**
 * Workspace files that feed one published artifact target. Matches the
 * bundler's `prepareKodyGraphFiles` input set: reachable source from the
 * entry, plus bundler root config and `node_modules` files that every
 * target receives.
 */
export function collectPublishedPackageArtifactInputPaths(input: {
	files: Record<string, string>
	entryPoint: string
}) {
	const rootPackage = readRootPackage(input.files)
	const paths = collectReachableSourceFilePaths({
		files: input.files,
		entryPoint: input.entryPoint,
		rootPackage,
	})
	for (const path of Object.keys(input.files)) {
		const normalized = normalizePackageWorkspacePath(path)
		if (
			isBundlerRootConfigPath(normalized) ||
			isBundlerRootDependencyPath(normalized)
		) {
			paths.add(normalized)
		}
	}
	return paths
}

function fileContentAt(
	files: Record<string, string>,
	path: string,
): string | undefined {
	if (Object.hasOwn(files, path)) return files[path]
	const normalized = normalizePackageWorkspacePath(path)
	if (normalized !== path && Object.hasOwn(files, normalized)) {
		return files[normalized]
	}
	return undefined
}

/**
 * True when this target cannot reuse the previous published artifact:
 * reachable inputs, bundler root config, or vendored `node_modules` differ
 * between snapshots, or the graph is empty so reuse cannot be proven.
 */
export function publishedPackageArtifactTargetInputsChanged(input: {
	entryPoint: string
	previousFiles: Record<string, string>
	nextFiles: Record<string, string>
}) {
	const previousPaths = collectPublishedPackageArtifactInputPaths({
		files: input.previousFiles,
		entryPoint: input.entryPoint,
	})
	const nextPaths = collectPublishedPackageArtifactInputPaths({
		files: input.nextFiles,
		entryPoint: input.entryPoint,
	})
	const paths = new Set([...previousPaths, ...nextPaths])
	if (paths.size === 0) return true
	for (const path of paths) {
		if (
			fileContentAt(input.previousFiles, path) !==
			fileContentAt(input.nextFiles, path)
		) {
			return true
		}
	}
	return false
}
