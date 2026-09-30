import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { throwIfPersonPackagePlatformReference } from '#worker/package-registry/platform-package-policy.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	buildPlainRepoPromotionErrorMessage,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
	SavedPackageNotFoundError,
} from './package-import-resolution.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from './static-kody-imports.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import { type BundleArtifactDependency } from './published-runtime-artifacts.ts'
import {
	dirname,
	joinPath,
	packageManifestPath,
	rootSourcePrefix,
	wranglerConfigPaths,
	resolveWorkspaceSourceFilePath,
} from './module-graph-paths.ts'

export function resolvePackageExportSourcePath(input: {
	files: Record<string, string>
	manifest: AuthoredPackageJson
	exportName: string
}) {
	const exportPath = resolvePackageExportPath({
		manifest: input.manifest,
		exportName: input.exportName,
	})
	return (
		resolveWorkspaceSourceFilePath({
			files: input.files,
			path: exportPath,
		}) ?? exportPath
	)
}

export function readRootPackage(sourceFiles: Record<string, string>) {
	const packageJson = sourceFiles[packageManifestPath]
	if (!packageJson) return null
	try {
		return {
			manifest: parseAuthoredPackageJson({ content: packageJson }),
			prefix: rootSourcePrefix,
		}
	} catch {
		return null
	}
}

export function isBundlerRootConfigPath(path: string) {
	return path === packageManifestPath || wranglerConfigPaths.includes(path)
}

export function isBundlerRootDependencyPath(path: string) {
	return path === 'node_modules' || path.startsWith('node_modules/')
}

function resolveLocalImportPath(input: {
	files: Record<string, string>
	fromPath: string
	specifier: string
}) {
	if (!input.specifier.startsWith('./') && !input.specifier.startsWith('../')) {
		return null
	}
	return resolveWorkspaceSourceFilePath({
		files: input.files,
		path: joinPath(dirname(input.fromPath), input.specifier),
	})
}

export function collectReachableSourceFilePaths(input: {
	files: Record<string, string>
	entryPoint: string
	rootPackage: {
		manifest: AuthoredPackageJson
		prefix: string
	} | null
	includeTypeOnly?: boolean
}) {
	const reachable = new Set<string>()
	const stack = [
		resolveWorkspaceSourceFilePath({
			files: input.files,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint),
	]
	while (stack.length > 0) {
		const filePath = stack.pop()
		if (
			!filePath ||
			reachable.has(filePath) ||
			isTypeDeclarationFilePath(filePath)
		) {
			continue
		}
		const source = input.files[filePath]
		if (source == null) continue
		reachable.add(filePath)
		for (const node of collectLiteralImportNodes(source, {
			includeTypeOnly: input.includeTypeOnly,
		})) {
			if (
				node.kind === 'static' &&
				node.specifier.startsWith(packageSpecifierPrefix)
			) {
				const parsed = parseKodyPackageSpecifier(node.specifier)
				if (parsed.packageName === input.rootPackage?.manifest.name) {
					const exportPath = resolvePackageExportPath({
						manifest: input.rootPackage.manifest,
						exportName: parsed.exportName,
					})
					stack.push(
						resolveWorkspaceSourceFilePath({
							files: input.files,
							path: exportPath,
						}) ?? exportPath,
					)
				}
				continue
			}
			const localPath = resolveLocalImportPath({
				files: input.files,
				fromPath: filePath,
				specifier: node.specifier,
			})
			if (localPath && !reachable.has(localPath)) {
				stack.push(localPath)
			}
		}
	}
	return reachable
}

type LoadedDependencyPackage = LoadedPackageSource & {
	row: SavedPackageRecord
	prefix: string
	sourceOwnerUserId: string
	platformScope: string | null
	shareOwned?: boolean
	storageOwnerUserId?: string
}

function createBundleArtifactDependency(input: {
	row: SavedPackageRecord
	sourceId: string
	publishedCommit: string
	platformScope: string | null
	shareOwned?: boolean
	storageOwnerUserId?: string
	sourceOwnerUserId: string
}): BundleArtifactDependency {
	return {
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		kodyId: input.row.kodyId,
		packageName: input.row.name,
		packageId: input.row.id,
		// Platform-owned dependency ids never become caller-side
		// packageStorage grants; see collectPackageStorageGrantIds.
		...(input.platformScope ? { platformOwned: true } : {}),
		...(input.shareOwned
			? {
					shareOwned: true,
					storageOwnerUserId:
						input.storageOwnerUserId ?? input.sourceOwnerUserId,
				}
			: {}),
	}
}

/**
 * Saved packages reached only through another saved package's static
 * `kody:@` imports, walked from each direct import's export entry over the
 * package sources `prepareKodyGraphFiles` already loaded. Their stamped
 * modules are inlined into this bundle, so they need the same host-side
 * provenance as direct imports. Only files reachable from the imported
 * export count, so a dependency's unrelated exports never widen the set.
 */
function collectTransitiveKodyDependencies(input: {
	directSpecifiers: Array<string>
	directPackageIds: ReadonlySet<string>
	rootPackageName: string | undefined
	loadedPackages: Map<string, LoadedDependencyPackage>
}): Array<BundleArtifactDependency> {
	const transitive = new Map<string, BundleArtifactDependency>()
	const visitedExports = new Set<string>()
	const pending: Array<{
		specifier: string
		importer: LoadedDependencyPackage | null
	}> = input.directSpecifiers.map((specifier) => ({
		specifier,
		importer: null,
	}))
	while (pending.length > 0) {
		const next = pending.pop()
		if (!next) continue
		const parsed = parseKodyPackageSpecifier(next.specifier)
		if (parsed.packageName === input.rootPackageName) continue
		// Mirrors ensurePackageLoaded: imports inside a share-owned package
		// resolve under the share owner, keyed `${name}#${ownerUserId}`.
		const nestedShareOwnerUserId =
			next.importer?.shareOwned === true
				? (next.importer.storageOwnerUserId ?? next.importer.sourceOwnerUserId)
				: undefined
		const loaded = input.loadedPackages.get(
			nestedShareOwnerUserId
				? `${parsed.packageName}#${nestedShareOwnerUserId}`
				: parsed.packageName,
		)
		if (!loaded) continue
		const exportEntryPoint = resolvePackageExportSourcePath({
			files: loaded.files,
			manifest: loaded.manifest,
			exportName: parsed.exportName,
		})
		const visitKey = `${loaded.row.id}\0${exportEntryPoint}`
		if (visitedExports.has(visitKey)) continue
		visitedExports.add(visitKey)
		const publishedCommit = loaded.source.published_commit
		if (
			next.importer &&
			publishedCommit &&
			!input.directPackageIds.has(loaded.row.id) &&
			!transitive.has(loaded.row.id)
		) {
			transitive.set(loaded.row.id, {
				...createBundleArtifactDependency({
					row: loaded.row,
					sourceId: loaded.source.id,
					publishedCommit,
					platformScope: loaded.platformScope,
					shareOwned: loaded.shareOwned,
					storageOwnerUserId: loaded.storageOwnerUserId,
					sourceOwnerUserId: loaded.sourceOwnerUserId,
				}),
				transitive: true,
			})
		}
		const reachable = collectReachableSourceFilePaths({
			files: loaded.files,
			entryPoint: exportEntryPoint,
			rootPackage: { manifest: loaded.manifest, prefix: '' },
		})
		const reachableFiles = Object.fromEntries(
			Object.entries(loaded.files).filter(([filePath]) =>
				reachable.has(filePath),
			),
		)
		for (const imported of collectStaticKodyPackageImportsFromFiles(
			reachableFiles,
		)) {
			if (imported.packageName === loaded.manifest.name) continue
			pending.push({ specifier: imported.specifier, importer: loaded })
		}
	}
	return [...transitive.values()]
}

/**
 * Bundle dependency metadata for one entry point: every saved package the
 * entry statically imports, plus packages those dependencies statically
 * import (marked `transitive`). Grants for `packageStorage()` and
 * stamp-aligned secret authority derive from this list.
 */
export async function resolveKodyDependenciesForEntryPoint(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	loadedPackages?: Map<string, LoadedDependencyPackage>
	allowPlatformScopes?: boolean
}) {
	const rootPackage = readRootPackage(input.sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
	})
	const reachableFiles = Object.fromEntries(
		Object.entries(input.sourceFiles).filter(([filePath]) =>
			reachable.has(filePath),
		),
	)
	const importedPackages = new Map<string, string>()
	for (const imported of collectStaticKodyPackageImportsFromFiles(
		reachableFiles,
	)) {
		if (imported.packageName === rootPackage?.manifest.name) continue
		importedPackages.set(imported.packageName, imported.specifier)
	}
	const sortedSpecifiers = [...importedPackages.values()].sort((left, right) =>
		left.localeCompare(right),
	)
	const dependencies = await Promise.all(
		sortedSpecifiers.map(async (specifier) => {
			const parsed = parseKodyPackageSpecifier(specifier)
			const cached = input.loadedPackages?.get(parsed.packageName)
			const resolution = cached
				? {
						row: cached.row,
						sourceOwnerUserId: cached.sourceOwnerUserId,
						platformScope: cached.platformScope,
						shareOwned: cached.shareOwned,
						storageOwnerUserId: cached.storageOwnerUserId,
					}
				: await resolveSavedPackageImport({
						db: input.env.APP_DB,
						userId: input.userId,
						specifier: parsed,
						allowPlatformScopes: input.allowPlatformScopes,
					})
			if (!resolution) {
				if (input.allowPlatformScopes !== true) {
					await throwIfPersonPackagePlatformReference({
						db: input.env.APP_DB,
						packageName: parsed.packageName,
					})
				}
				const plainRepo = await findPlainRepoPromotionHint(input.env.APP_DB, {
					userId: input.userId,
					packageIdOrKodyId: parsed.packageName,
				})
				if (plainRepo) {
					throw new Error(
						buildPlainRepoPromotionErrorMessage(parsed.packageName),
					)
				}
				throw new SavedPackageNotFoundError(parsed.packageName)
			}
			const { row } = resolution
			const loaded =
				cached ??
				(await loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: resolution.sourceOwnerUserId,
					sourceId: row.sourceId,
				}))
			if (!loaded.source.published_commit) {
				throw new Error(
					`Saved package "${row.name}" source "${row.sourceId}" has no published commit.`,
				)
			}
			return createBundleArtifactDependency({
				row,
				sourceId: loaded.source.id,
				publishedCommit: loaded.source.published_commit,
				platformScope: resolution.platformScope,
				shareOwned: resolution.shareOwned,
				storageOwnerUserId: resolution.storageOwnerUserId,
				sourceOwnerUserId: resolution.sourceOwnerUserId,
			})
		}),
	)
	const transitiveDependencies = input.loadedPackages
		? collectTransitiveKodyDependencies({
				directSpecifiers: sortedSpecifiers,
				directPackageIds: new Set(
					dependencies
						.map((dependency) => dependency.packageId)
						.filter((packageId): packageId is string => Boolean(packageId)),
				),
				rootPackageName: rootPackage?.manifest.name,
				loadedPackages: input.loadedPackages,
			})
		: []
	return [...dependencies, ...transitiveDependencies].sort(
		(left, right) =>
			left.kodyId.localeCompare(right.kodyId) ||
			left.sourceId.localeCompare(right.sourceId),
	)
}
