import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
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
} from './package-import-resolution.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from './static-kody-imports.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
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
		for (const node of collectLiteralImportNodes(source)) {
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

export async function resolveDirectKodyDependenciesForEntryPoint(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	loadedPackages?: Map<
		string,
		LoadedPackageSource & { row: SavedPackageRecord; prefix: string }
	>
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
			const row =
				cached?.row ??
				(await resolveSavedPackageImport({
					db: input.env.APP_DB,
					userId: input.userId,
					specifier: parsed,
				}))
			if (!row) {
				const plainRepo = await findPlainRepoPromotionHint(input.env.APP_DB, {
					userId: input.userId,
					packageIdOrKodyId: parsed.packageName,
				})
				throw new Error(
					plainRepo
						? buildPlainRepoPromotionErrorMessage(parsed.packageName)
						: `Saved package "${parsed.packageName}" was not found for this user.`,
				)
			}
			const loaded =
				cached ??
				(await loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: row.sourceId,
				}))
			if (!loaded.source.published_commit) {
				throw new Error(
					`Saved package "${row.name}" source "${row.sourceId}" has no published commit.`,
				)
			}
			return {
				sourceId: loaded.source.id,
				publishedCommit: loaded.source.published_commit,
				kodyId: row.kodyId,
				packageName: row.name,
				packageId: row.id,
			}
		}),
	)
	return dependencies.sort(
		(left, right) =>
			left.kodyId.localeCompare(right.kodyId) ||
			left.sourceId.localeCompare(right.sourceId),
	)
}
