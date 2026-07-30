import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'
import { loadPublishedBundleArtifactByIdentity } from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'
import {
	collectDynamicImportExpressionNodes,
	collectLiteralImportNodes,
} from './import-specifiers.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	dirname,
	encodePathKeyAsPath,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageManifestPath,
	packageSourcePrefix,
	rootSourcePrefix,
	dynamicPackageImportProxyPrefix,
	resolveRelativeModulePath,
	resolveWorkspaceSourceFilePath,
	runtimeModulePath,
} from './module-graph-paths.ts'
import {
	buildPackageRuntimeModulePath,
	createComputedDynamicImportGuardSource,
	createDynamicPackageImportHelperSource,
	createDynamicPackageImportPlaceholderSource,
	createMeteredPackageImportProxySource,
	createPackageImportProxySource,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
	iterateModuleSourceTexts,
} from './runtime-source-modules.ts'
import { collectModuleExportNames } from './module-export-names.ts'
import { materializePublishedArtifactModules } from './module-graph-artifacts.ts'
import {
	collectReachableSourceFilePaths,
	isBundlerRootConfigPath,
	isBundlerRootDependencyPath,
	readRootPackage,
	resolvePackageExportSourcePath,
} from './module-graph-workspace.ts'

type RewriteReplacement = {
	start: number
	end: number
	value: string
}

export type LoadedKodyGraphPackage = LoadedPackageSource & {
	row: SavedPackageRecord
	prefix: string
}

export type LoadedKodyGraphPackages = Map<string, LoadedKodyGraphPackage>

type RewriteState = {
	env: Env
	baseUrl: string
	userId: string
	files: Record<string, string>
	sourceFiles: Record<string, string>
	rootPackage: {
		manifest: AuthoredPackageJson
		prefix: string
	} | null
	/**
	 * Saved-package UUID of the root source when the graph is being built for
	 * a saved package's own module (publish/invocation builds). Root modules
	 * are then stamped with per-package runtime modules just like statically
	 * imported dependency modules, so the stamp survives into published
	 * artifacts that later get composed into foreign bundles.
	 */
	rootPackageId: string | null
	includeTypeOnlyKodyPackages: boolean
	proxies: Map<string, string>
	dynamicPackageImports: Map<string, string>
	packages: LoadedKodyGraphPackages
}

async function maybeEnsurePublishedArtifactTarget(input: {
	state: RewriteState
	specifier: string
	loaded: LoadedKodyGraphPackage
}): Promise<string | null> {
	if (!input.loaded.source.published_commit) {
		return null
	}
	const parsed = parseKodyPackageSpecifier(input.specifier)
	const exportName = normalizePackageExportKey(parsed.exportName)
	const entryPoint = resolvePackageExportPath({
		manifest: input.loaded.manifest,
		exportName,
	})
	const artifact = await loadPublishedBundleArtifactByIdentity({
		env: input.state.env,
		userId: input.state.userId,
		sourceId: input.loaded.row.sourceId,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
	})
	if (!artifact?.artifact) {
		return null
	}
	const artifactPrefix = joinPath(
		input.loaded.prefix,
		'.__published_bundle__',
		encodePathKeyAsPath(exportName),
	)
	for (const [modulePath, module] of Object.entries(
		materializePublishedArtifactModules({
			artifactPrefix,
			modules: artifact.artifact.modules,
		}),
	)) {
		input.state.files[modulePath] = module
	}
	return joinPath(artifactPrefix, artifact.artifact.mainModule)
}

function applyReplacements(
	source: string,
	replacements: Array<RewriteReplacement>,
) {
	if (replacements.length === 0) return source
	let cursor = 0
	let nextSource = ''
	for (const replacement of replacements) {
		nextSource += source.slice(cursor, replacement.start)
		nextSource += replacement.value
		cursor = replacement.end
	}
	nextSource += source.slice(cursor)
	return nextSource
}

function assertReplacementsDoNotOverlap(
	replacements: Array<RewriteReplacement>,
) {
	for (let index = 1; index < replacements.length; index += 1) {
		const previous = replacements[index - 1]
		const current = replacements[index]
		if (!previous || !current || current.start >= previous.end) continue
		throw new Error(
			'Nested dynamic import expressions involving Kody package imports are unsupported. Keep import("kody:@scope/package/export") as its own expression.',
		)
	}
}

async function ensurePackageLoaded(
	state: RewriteState,
	specifier: string,
): Promise<LoadedKodyGraphPackage> {
	const parsed = parseKodyPackageSpecifier(specifier)
	const packageKey = parsed.packageName
	const existing = state.packages.get(packageKey)
	if (existing) return existing
	const row = await resolveSavedPackageImport({
		db: state.env.APP_DB,
		userId: state.userId,
		specifier: parsed,
	})
	if (!row) {
		throw new Error(
			`Saved package "${parsed.packageName}" was not found for this user.`,
		)
	}
	const loaded = await loadPackageSourceBySourceId({
		env: state.env,
		baseUrl: state.baseUrl,
		userId: state.userId,
		sourceId: row.sourceId,
	})
	const entry = {
		...loaded,
		row,
		prefix: joinPath(packageSourcePrefix, packageKey),
	}
	state.packages.set(packageKey, entry)
	for (const [filePath, content] of Object.entries(loaded.files)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		const targetPath = joinPath(entry.prefix, normalizedPath)
		if (isTypeDeclarationFilePath(normalizedPath)) {
			state.files[targetPath] = content
			if (state.includeTypeOnlyKodyPackages) {
				for (const node of collectLiteralImportNodes(content, {
					includeTypeOnly: true,
				})) {
					if (
						node.kind === 'static' &&
						node.specifier.startsWith(packageSpecifierPrefix)
					) {
						await ensurePackageLoaded(state, node.specifier)
					}
				}
			}
			continue
		}
		state.files[targetPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: targetPath,
			sourcePackageId: row.id,
		})
	}
	return entry
}

async function ensurePackageProxy(
	state: RewriteState,
	specifier: string,
): Promise<string> {
	const existing = state.proxies.get(specifier)
	if (existing) return existing
	const parsed = parseKodyPackageSpecifier(specifier)
	// Callee saved-package UUID stamped into the metered proxy below. Root
	// self-imports resolve back into the bundle's own source and are not
	// stamped: the surrounding run already meters that package via
	// `package_export`.
	let calleePackageId: string | null = null
	const absoluteExportPath =
		parsed.packageName === state.rootPackage?.manifest.name
			? joinPath(
					state.rootPackage.prefix,
					resolvePackageExportSourcePath({
						files: state.sourceFiles,
						manifest: state.rootPackage.manifest,
						exportName: parsed.exportName,
					}),
				)
			: await (async () => {
					const loaded = await ensurePackageLoaded(state, specifier)
					calleePackageId = loaded.row.id
					return (
						(await maybeEnsurePublishedArtifactTarget({
							state,
							specifier,
							loaded,
						})) ??
						(() => {
							assertPublishedSourceCanRebuildWithoutInstallingDeps({
								sourceFiles: loaded.files,
								bundleLabel: `Saved package export "${normalizePackageExportKey(
									parsed.exportName,
								)}"`,
							})
							const exportPath = resolvePackageExportSourcePath({
								files: loaded.files,
								manifest: loaded.manifest,
								exportName: parsed.exportName,
							})
							return joinPath(loaded.prefix, exportPath)
						})()
					)
				})()
	const proxyPath = joinPath(
		packageImportProxyPrefix,
		`${createPackageProxyPathSegment(specifier)}.js`,
	)
	const proxyTarget = createRelativeImportSpecifier(
		proxyPath,
		absoluteExportPath,
	)
	state.files[proxyPath] = calleePackageId
		? createMeteredPackageImportProxySource({
				targetPath: proxyTarget,
				runtimeSpecifier: createRelativeImportSpecifier(
					proxyPath,
					runtimeModulePath,
				),
				packageId: calleePackageId,
				exportNames: collectModuleExportNames({
					files: state.files,
					modulePath: absoluteExportPath,
				}),
			})
		: createPackageImportProxySource({
				targetPath: proxyTarget,
			})
	state.proxies.set(specifier, proxyPath)
	return proxyPath
}

function ensureDynamicPackageImportProxy(
	state: RewriteState,
	specifier: string,
) {
	const existing = state.dynamicPackageImports.get(specifier)
	if (existing) return existing
	const proxyPath = joinPath(
		dynamicPackageImportProxyPrefix,
		`${createPackageProxyPathSegment(specifier)}.js`,
	)
	state.files[proxyPath] = createDynamicPackageImportPlaceholderSource({
		specifier,
	})
	state.dynamicPackageImports.set(specifier, proxyPath)
	return proxyPath
}

export function collectDynamicPackageImportProxyModules(
	files: Record<string, string>,
	emittedModules: WorkerLoaderModules,
) {
	const referencedProxyPaths =
		collectReferencedDynamicPackageImportProxyPaths(emittedModules)
	return Object.fromEntries(
		Object.entries(files).filter(([modulePath]) => {
			const normalizedPath = normalizeWorkspaceModulePath(modulePath)
			return (
				isDynamicPackageImportProxyPath(normalizedPath) &&
				referencedProxyPaths.has(normalizedPath)
			)
		}),
	)
}

function isDynamicPackageImportProxyPath(modulePath: string) {
	return (
		modulePath.startsWith(`${dynamicPackageImportProxyPrefix}/`) ||
		modulePath.includes(`/${dynamicPackageImportProxyPrefix}/`)
	)
}

function collectReferencedDynamicPackageImportProxyPaths(
	modules: WorkerLoaderModules,
) {
	const referencedPaths = new Set<string>()
	const proxyReferencePattern =
		/["']((?:\.\.?\/)?[^"']*\.?__kody_virtual__\/dynamic-imports\/[^"']+?\.js)["']/g
	for (const [modulePath, module] of iterateModuleSourceTexts(modules)) {
		if (
			isDynamicPackageImportProxyPath(normalizeWorkspaceModulePath(modulePath))
		) {
			referencedPaths.add(normalizeWorkspaceModulePath(modulePath))
		}
		for (const match of module.matchAll(proxyReferencePattern)) {
			const specifier = match[1]
			if (!specifier) continue
			const resolvedPath = resolveRelativeModulePath(modulePath, specifier)
			referencedPaths.add(
				resolvedPath ?? normalizeWorkspaceModulePath(specifier),
			)
		}
	}
	return referencedPaths
}

function createUniqueHelperName(source: string, baseName: string) {
	let candidate = baseName
	let suffix = 0
	while (source.includes(candidate)) {
		suffix += 1
		candidate = `${baseName}${suffix}`
	}
	return candidate
}

function ensurePackageRuntimeModule(state: RewriteState, packageId: string) {
	const modulePath = buildPackageRuntimeModulePath(packageId)
	state.files[modulePath] ??= createPackageRuntimeModuleSource(packageId)
	return modulePath
}

async function rewriteKodyImports(input: {
	state: RewriteState
	source: string
	modulePath: string
	/**
	 * Saved-package UUID the module's source belongs to, or null for
	 * unprovenanced source (ad hoc execute entry code). Stamped modules get
	 * their `kody:runtime` import rewritten to a per-package virtual runtime
	 * module so `packageStorage()` resolves to the declaring package.
	 */
	sourcePackageId: string | null
}) {
	const importNodes = collectLiteralImportNodes(input.source, {
		includeTypeOnly: input.state.includeTypeOnlyKodyPackages,
	})
	const dynamicImportNodes = collectDynamicImportExpressionNodes(input.source)
	if (importNodes.length === 0 && dynamicImportNodes.length === 0) {
		return input.source
	}
	const replacements: Array<RewriteReplacement> = []
	for (const node of importNodes) {
		if (node.specifier === 'kody:runtime') {
			const runtimeTargetPath = input.sourcePackageId
				? ensurePackageRuntimeModule(input.state, input.sourcePackageId)
				: runtimeModulePath
			replacements.push({
				start: node.start,
				end: node.end,
				value: JSON.stringify(
					createRelativeImportSpecifier(input.modulePath, runtimeTargetPath),
				),
			})
			continue
		}
		if (!node.specifier.startsWith(packageSpecifierPrefix)) {
			continue
		}
		if (node.kind === 'dynamic') {
			continue
		}
		const proxyPath = await ensurePackageProxy(input.state, node.specifier)
		replacements.push({
			start: node.start,
			end: node.end,
			value: JSON.stringify(
				createRelativeImportSpecifier(input.modulePath, proxyPath),
			),
		})
	}
	let computedImportHelperName: string | null = null
	let dynamicPackageImportHelperName: string | null = null
	for (const node of dynamicImportNodes) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			const proxyPath = ensureDynamicPackageImportProxy(
				input.state,
				node.literalSpecifier,
			)
			input.state.files[joinPath(rootSourcePrefix, proxyPath)] ??=
				input.state.files[proxyPath] ?? ''
			input.state.files[joinPath(dirname(input.modulePath), proxyPath)] ??=
				input.state.files[proxyPath] ?? ''
			dynamicPackageImportHelperName ??= createUniqueHelperName(
				input.source,
				'__kodyDynamicPackageImport',
			)
			replacements.push({
				start: node.start,
				end: node.end,
				value: `${dynamicPackageImportHelperName}(${JSON.stringify(
					`./${proxyPath}`,
				)}, ${JSON.stringify(node.literalSpecifier)})`,
			})
			continue
		}
		if (node.literalSpecifier != null) continue
		computedImportHelperName ??= createUniqueHelperName(
			input.source,
			'__kodyDynamicImportGuard',
		)
		replacements.push({
			start: node.start,
			end: node.end,
			value: `${computedImportHelperName}(${input.source.slice(
				node.sourceStart,
				node.sourceEnd,
			)})`,
		})
	}
	const sortedReplacements = replacements.sort(
		(left, right) => left.start - right.start,
	)
	assertReplacementsDoNotOverlap(sortedReplacements)
	const rewritten = applyReplacements(input.source, sortedReplacements)
	const helpers = [
		dynamicPackageImportHelperName
			? createDynamicPackageImportHelperSource({
					helperName: dynamicPackageImportHelperName,
				})
			: '',
		computedImportHelperName
			? createComputedDynamicImportGuardSource({
					helperName: computedImportHelperName,
				})
			: '',
	].filter(Boolean)
	return helpers.length > 0 ? `${helpers.join('\n')}\n${rewritten}` : rewritten
}

export async function prepareKodyGraphFiles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	rootPackageId?: string | null
	includeTypeOnlyKodyPackages?: boolean
}) {
	const files: Record<string, string> = {
		[runtimeModulePath]: createRuntimeModuleSource(),
	}
	const rootPackage = readRootPackage(input.sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const reachableRootFiles = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
	})
	const state: RewriteState = {
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		files,
		sourceFiles: input.sourceFiles,
		rootPackage,
		rootPackageId: input.rootPackageId?.trim() || null,
		includeTypeOnlyKodyPackages: input.includeTypeOnlyKodyPackages === true,
		proxies: new Map(),
		dynamicPackageImports: new Map(),
		packages: new Map(),
	}
	for (const [filePath, content] of Object.entries(input.sourceFiles)) {
		const normalizedSourcePath = normalizePackageWorkspacePath(filePath)
		if (
			isBundlerRootConfigPath(normalizedSourcePath) ||
			isBundlerRootDependencyPath(normalizedSourcePath)
		) {
			files[normalizedSourcePath] = content
		}
		if (isBundlerRootDependencyPath(normalizedSourcePath)) {
			continue
		}
		const normalizedPath = joinPath(rootSourcePrefix, normalizedSourcePath)
		if (normalizedSourcePath === packageManifestPath) {
			files[normalizedPath] = content
			continue
		}
		if (!reachableRootFiles.has(normalizedSourcePath)) {
			continue
		}
		if (isTypeDeclarationFilePath(normalizedSourcePath)) {
			files[normalizedPath] = content
			continue
		}
		files[normalizedPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: normalizedPath,
			sourcePackageId: state.rootPackageId,
		})
	}
	return {
		files,
		packages: state.packages,
	}
}
