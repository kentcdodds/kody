import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { throwIfPersonPackagePlatformReference } from '#worker/package-registry/platform-package-policy.ts'
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
import {
	assertPublishedSourceCanRebuildWithoutInstallingDeps,
	canRebuildPublishedSourceWithoutInstallingDeps,
} from './published-source-dependencies.ts'
import { applyXSearchRecentPaginationPatch } from './x-search-recent-pagination.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'
import { assertNotSealedSecretProviderExport } from '#mcp/secrets/secret-providers/sealed-export.ts'
import {
	collectBundlerResolvedSpecifiers,
	collectDynamicImportExpressionNodes,
	collectLiteralImportNodes,
} from './import-specifiers.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	encodePathKeyAsPath,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageManifestPath,
	packageSourcePrefix,
	rootSourcePrefix,
	dynamicPackageImportProxyPrefix,
	publicRuntimeModulePath,
	resolveRelativeModulePath,
	specifierTargetsKodyVirtualModule,
	textMentionsKodyVirtualModule,
	resolveWorkspaceSourceFilePath,
	runtimeModulePath,
} from './module-graph-paths.ts'
import {
	buildInternalKodyVirtualImportMessage,
	buildPackageRuntimeModulePath,
	createComputedDynamicImportGuardSource,
	createRemovedDynamicKodyImportHelperSource,
	createMeteredPackageImportProxySource,
	createPackageImportProxySource,
	createPackageRuntimeModuleSource,
	createPublicRuntimeModuleSource,
	createRuntimeModuleSource,
	iterateModuleSourceTexts,
	refreshKodyRuntimeModules,
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
	/**
	 * User id the source was loaded under: the caller for own packages, the
	 * platform account's stable id for live platform-scope imports.
	 */
	sourceOwnerUserId: string
	/** Platform scope username when resolved live (e.g. "kody"), else null. */
	platformScope: string | null
	shareOwned?: boolean
	storageOwnerUserId?: string
	/**
	 * The published importable artifact was built from source that did not
	 * forward recent-search `next_token`. The snapshot can be bundled from
	 * source, so the proxy uses the patched files instead of that artifact.
	 */
	skipPublishedArtifacts?: boolean
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
	/**
	 * Platform-account package graphs may resolve live `@kody/*` imports
	 * when composing with other platform scopes (decision 0036). Person
	 * accounts — ad hoc execute and saved packages — must not.
	 */
	allowPlatformScopes: boolean
	proxies: Map<string, string>
	dynamicPackageImports: Map<string, string>
	packages: LoadedKodyGraphPackages
}

async function maybeEnsurePublishedArtifactTarget(input: {
	state: RewriteState
	specifier: string
	loaded: LoadedKodyGraphPackage
}): Promise<string | null> {
	if (input.loaded.skipPublishedArtifacts) return null
	if (!input.loaded.source.published_commit) {
		return null
	}
	const parsed = parseKodyPackageSpecifier(input.specifier)
	assertNotSealedSecretProviderExport(parsed.exportName)
	const exportName = normalizePackageExportKey(parsed.exportName)
	const entryPoint = resolvePackageExportPath({
		manifest: input.loaded.manifest,
		exportName,
	})
	// Published artifacts are persisted by the owner at publish time, so
	// platform-scope imports read them under the platform account's id.
	const artifact = await loadPublishedBundleArtifactByIdentity({
		env: input.state.env,
		userId: input.loaded.sourceOwnerUserId,
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

function nestedShareOwnerUserIdFor(
	state: RewriteState,
	sourcePackageId: string | null,
) {
	if (!sourcePackageId) return undefined
	for (const loaded of state.packages.values()) {
		if (loaded.row.id === sourcePackageId && loaded.shareOwned === true) {
			return loaded.storageOwnerUserId ?? loaded.sourceOwnerUserId
		}
	}
	return undefined
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
	nestedShareOwnerUserId?: string,
): Promise<LoadedKodyGraphPackage> {
	const parsed = parseKodyPackageSpecifier(specifier)
	const packageKey = nestedShareOwnerUserId
		? `${parsed.packageName}#${nestedShareOwnerUserId}`
		: parsed.packageName
	const existing = state.packages.get(packageKey)
	if (existing) return existing
	const resolution = await resolveSavedPackageImport({
		db: state.env.APP_DB,
		userId: state.userId,
		specifier: parsed,
		allowPlatformScopes: state.allowPlatformScopes,
		nestedShareOwnerUserId,
	})
	if (!resolution) {
		if (!state.allowPlatformScopes) {
			await throwIfPersonPackagePlatformReference({
				db: state.env.APP_DB,
				packageName: parsed.packageName,
			})
		}
		throw new Error(
			`Saved package "${parsed.packageName}" was not found for this user.`,
		)
	}
	const { row } = resolution
	const loaded = await loadPackageSourceBySourceId({
		env: state.env,
		baseUrl: state.baseUrl,
		userId: resolution.sourceOwnerUserId,
		sourceId: row.sourceId,
	})
	const patched = applyXSearchRecentPaginationPatch(loaded.files)
	const usePatchedSource =
		patched.changed &&
		canRebuildPublishedSourceWithoutInstallingDeps(patched.files)
	const packageFiles = usePatchedSource ? patched.files : loaded.files
	const entry = {
		...loaded,
		files: packageFiles,
		row,
		prefix: joinPath(packageSourcePrefix, packageKey),
		sourceOwnerUserId: resolution.sourceOwnerUserId,
		platformScope: resolution.platformScope,
		shareOwned: resolution.shareOwned,
		storageOwnerUserId: resolution.storageOwnerUserId,
		skipPublishedArtifacts: usePatchedSource,
	}
	state.packages.set(packageKey, entry)
	for (const [filePath, content] of Object.entries(packageFiles)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		assertNoKodyVirtualModuleReference(normalizedPath, content)
		const targetPath = joinPath(entry.prefix, normalizedPath)
		if (isTypeDeclarationFilePath(normalizedPath)) {
			state.files[targetPath] = content
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
	nestedShareOwnerUserId?: string,
): Promise<string> {
	const existing = state.proxies.get(specifier)
	if (existing) return existing
	const parsed = parseKodyPackageSpecifier(specifier)
	assertNotSealedSecretProviderExport(parsed.exportName)
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
					const loaded = await ensurePackageLoaded(
						state,
						specifier,
						nestedShareOwnerUserId,
					)
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

function ensurePublicRuntimeModule(state: RewriteState) {
	state.files[publicRuntimeModulePath] ??= createPublicRuntimeModuleSource()
	return publicRuntimeModulePath
}

const bundlerScriptSourcePathPattern = /\.(?:[cm]?[jt]sx?)$/i
const bundlerConfigSourcePathPattern = /\.(?:jsonc?|toml)$/i

function jsonValueTargetsKodyVirtualModule(value: unknown): boolean {
	if (typeof value === 'string') {
		return !/\s/.test(value) && specifierTargetsKodyVirtualModule(value)
	}
	if (Array.isArray(value)) {
		return value.some(jsonValueTargetsKodyVirtualModule)
	}
	if (value != null && typeof value === 'object') {
		return Object.values(value).some(jsonValueTargetsKodyVirtualModule)
	}
	return false
}

/**
 * Whether a package-authored file can make the bundler resolve a module in
 * the virtual directory. Scripts are judged by the specifiers the bundler
 * resolves (`import`, `export … from`, literal `import()` / `require()`), so
 * a comment or string that only names the directory (for example an esbuild
 * `// virtual:` marker in committed bundle output) still builds. JSON is
 * judged by whitespace-free string values (`main`, `exports`, `alias`, …),
 * so prose does not match. Files that mention the directory but cannot be
 * inspected precisely (unparseable scripts, JSONC with comments, TOML) fail
 * closed.
 */
function fileReachesKodyVirtualModule(filePath: string, content: string) {
	if (!textMentionsKodyVirtualModule(content)) return false
	if (bundlerScriptSourcePathPattern.test(filePath)) {
		const specifiers = collectBundlerResolvedSpecifiers(content)
		return (
			specifiers == null || specifiers.some(specifierTargetsKodyVirtualModule)
		)
	}
	if (/\.jsonc?$/i.test(filePath)) {
		try {
			return jsonValueTargetsKodyVirtualModule(JSON.parse(content))
		} catch {
			return true
		}
	}
	return bundlerConfigSourcePathPattern.test(filePath)
}

/**
 * Covers every package-authored file handed to the bundler, including
 * `node_modules/` and config copied without import rewriting (package.json
 * `exports` / `imports` / `main` and wrangler `main` / `alias` could
 * otherwise point there).
 */
function assertNoKodyVirtualModuleReference(filePath: string, content: string) {
	if (isTypeDeclarationFilePath(filePath)) return
	if (!fileReachesKodyVirtualModule(filePath, content)) return
	const label = bundlerScriptSourcePathPattern.test(filePath)
		? `Package source "${filePath}"`
		: `Package config "${filePath}"`
	throw new Error(buildInternalKodyVirtualImportMessage(label))
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
	const importNodes = collectLiteralImportNodes(input.source)
	const dynamicImportNodes = collectDynamicImportExpressionNodes(input.source)
	if (importNodes.length === 0 && dynamicImportNodes.length === 0) {
		return input.source
	}
	const replacements: Array<RewriteReplacement> = []
	for (const node of importNodes) {
		if (node.specifier === 'kody:runtime') {
			const runtimeTargetPath = input.sourcePackageId
				? ensurePackageRuntimeModule(input.state, input.sourcePackageId)
				: ensurePublicRuntimeModule(input.state)
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
		const proxyPath = await ensurePackageProxy(
			input.state,
			node.specifier,
			nestedShareOwnerUserIdFor(input.state, input.sourcePackageId),
		)
		replacements.push({
			start: node.start,
			end: node.end,
			value: JSON.stringify(
				createRelativeImportSpecifier(input.modulePath, proxyPath),
			),
		})
	}
	let computedImportHelperName: string | null = null
	let removedDynamicImportHelperName: string | null = null
	for (const node of dynamicImportNodes) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			// Permanent guard: the call site becomes a teaching error naming the
			// replacement, matching the publish-time rejection.
			removedDynamicImportHelperName ??= createUniqueHelperName(
				input.source,
				'__kodyRemovedDynamicKodyImport',
			)
			replacements.push({
				start: node.start,
				end: node.end,
				value: `${removedDynamicImportHelperName}(${JSON.stringify(
					node.literalSpecifier,
				)})`,
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
		removedDynamicImportHelperName
			? createRemovedDynamicKodyImportHelperSource({
					helperName: removedDynamicImportHelperName,
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
	allowPlatformScopes?: boolean
}) {
	const sourceFiles = applyXSearchRecentPaginationPatch(input.sourceFiles).files
	const files: Record<string, string> = {
		[runtimeModulePath]: createRuntimeModuleSource(),
	}
	const rootPackage = readRootPackage(sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const reachableRootFiles = collectReachableSourceFilePaths({
		files: sourceFiles,
		entryPoint,
		rootPackage,
	})
	const state: RewriteState = {
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		files,
		sourceFiles,
		rootPackage,
		rootPackageId: input.rootPackageId?.trim() || null,
		allowPlatformScopes: input.allowPlatformScopes === true,
		proxies: new Map(),
		dynamicPackageImports: new Map(),
		packages: new Map(),
	}
	for (const [filePath, content] of Object.entries(sourceFiles)) {
		const normalizedSourcePath = normalizePackageWorkspacePath(filePath)
		if (
			isBundlerRootConfigPath(normalizedSourcePath) ||
			isBundlerRootDependencyPath(normalizedSourcePath) ||
			reachableRootFiles.has(normalizedSourcePath)
		) {
			assertNoKodyVirtualModuleReference(normalizedSourcePath, content)
		}
		if (isBundlerRootConfigPath(normalizedSourcePath)) {
			files[normalizedSourcePath] = content
		}
		if (isBundlerRootDependencyPath(normalizedSourcePath)) {
			// Same rewrite dependency packages get in ensurePackageLoaded, so
			// computed import() in installed dependency code hits the guard.
			files[normalizedSourcePath] =
				bundlerScriptSourcePathPattern.test(normalizedSourcePath) &&
				!isTypeDeclarationFilePath(normalizedSourcePath)
					? await rewriteKodyImports({
							state,
							source: content,
							modulePath: normalizedSourcePath,
							sourcePackageId: state.rootPackageId,
						})
					: content
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
		files: refreshKodyRuntimeModules(files) as Record<string, string>,
		packages: state.packages,
	}
}
