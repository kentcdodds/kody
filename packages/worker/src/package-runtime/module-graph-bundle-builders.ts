import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import {
	createPublishedPackageCacheKey,
	createPublishedPackagePromiseCache,
} from '#worker/package-registry/published-package-cache.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type RuntimeBundle } from './runtime-bundle-types.ts'
import {
	createRelativeImportSpecifier,
	joinPath,
	rootSourcePrefix,
	resolveWorkspaceSourceFilePath,
} from './module-graph-paths.ts'
import {
	assertBundleHasNoUnresolvedBareImports,
	includeDynamicDependenciesWhenPresent,
} from './module-graph-artifacts.ts'
import {
	collectDynamicPackageImportProxyModules,
	prepareKodyGraphFiles,
} from './module-graph-import-rewriting.ts'
import { resolveDirectKodyDependenciesForEntryPoint } from './module-graph-workspace.ts'
import {
	createAppEntrypointSource,
	createExecuteEntrypointSource,
	createImportableEntrypointSource,
	stripKodyRuntimeModules,
} from './runtime-source-modules.ts'

const packageAppBundleCache =
	createPublishedPackagePromiseCache<RuntimeBundle>()
const moduleBundleCache = createPublishedPackagePromiseCache<RuntimeBundle>()

async function createWorkerBundle(input: {
	files: Record<string, string>
	entryPoint: string
}) {
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createWorker } = await import('@cloudflare/worker-bundler')
	return await createWorker(input)
}

function serializePreparedFilesRecord(files: Record<string, string>) {
	const sortedKeys = Object.keys(files).sort()
	const record: Record<string, string> = {}
	for (const key of sortedKeys) {
		const content = files[key]
		if (content === undefined) continue
		record[key] = content
	}
	return JSON.stringify(record)
}

async function createModuleBundleCacheKey(input: {
	userId: string
	entryPoint: string
	files: Record<string, string>
}) {
	// Digest prepared files (not raw source) so package republishes that change
	// rewritten graph contents invalidate the cache without a staleness window.
	const filesDigest = await sha256Base64Url(
		serializePreparedFilesRecord(input.files),
	)
	return JSON.stringify([
		'module-bundle',
		input.userId,
		input.entryPoint,
		filesDigest,
	])
}

function cloneRuntimeBundle(bundle: RuntimeBundle): RuntimeBundle {
	return {
		mainModule: bundle.mainModule,
		modules: { ...bundle.modules },
		dependencies: [...bundle.dependencies],
		...(bundle.dynamicDependencies
			? { dynamicDependencies: [...bundle.dynamicDependencies] }
			: {}),
	}
}

export async function buildKodyModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
	// Opt-in: cache createWorkerBundle by prepared-files digest (see createModuleBundleCacheKey).
	reuseCachedBundle?: boolean
}) {
	const { files, packages } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
	})
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
	const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_execute_entry__.js')
	files[bootstrapPath] = createExecuteEntrypointSource({
		modulePath: createRelativeImportSpecifier(
			bootstrapPath,
			normalizedEntrypoint,
		),
	})
	const assembleBundle = async (): Promise<RuntimeBundle> => {
		const bundle = await createWorkerBundle({
			files,
			entryPoint: bootstrapPath,
		})
		const modules = {
			...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
			...collectDynamicPackageImportProxyModules(
				files,
				bundle.modules as WorkerLoaderModules,
			),
		}
		assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: `Saved package module "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
		})
		return {
			mainModule: bundle.mainModule,
			modules,
			dependencies: await resolveDirectKodyDependenciesForEntryPoint({
				...input,
				loadedPackages: packages,
			}),
			...includeDynamicDependenciesWhenPresent(modules),
		}
	}

	if (!input.reuseCachedBundle) {
		return await assembleBundle()
	}

	const cacheKey = await createModuleBundleCacheKey({
		userId: input.userId,
		entryPoint,
		files,
	})
	const cached = await moduleBundleCache.getOrCreate({
		cacheKey,
		create: assembleBundle,
	})
	return cloneRuntimeBundle(cached)
}

export async function buildKodyImportableModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
}) {
	const { files, packages } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
	})
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
	const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_import_entry__.js')
	files[bootstrapPath] = createImportableEntrypointSource({
		modulePath: createRelativeImportSpecifier(
			bootstrapPath,
			normalizedEntrypoint,
		),
	})
	const bundle = await createWorkerBundle({
		files,
		entryPoint: bootstrapPath,
	})
	const modules = {
		...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
		...collectDynamicPackageImportProxyModules(
			files,
			bundle.modules as WorkerLoaderModules,
		),
	}
	assertBundleHasNoUnresolvedBareImports({
		modules,
		bundleLabel: `Saved package import "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
	})
	return {
		mainModule: bundle.mainModule,
		modules,
		dependencies: await resolveDirectKodyDependenciesForEntryPoint({
			...input,
			loadedPackages: packages,
		}),
		...includeDynamicDependenciesWhenPresent(modules),
	}
}

export async function buildKodyAppBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
	cacheKey?: string | null
}) {
	const buildBundle = async () => {
		const { files, packages } = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles: input.sourceFiles,
			entryPoint: input.entryPoint,
			rootPackageId: input.rootPackageId,
		})
		const entryPoint =
			resolveWorkspaceSourceFilePath({
				files: input.sourceFiles,
				path: input.entryPoint,
			}) ?? normalizePackageWorkspacePath(input.entryPoint)
		const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
		const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_app_entry__.js')
		files[bootstrapPath] = createAppEntrypointSource({
			modulePath: createRelativeImportSpecifier(
				bootstrapPath,
				normalizedEntrypoint,
			),
		})
		const bundle = await createWorkerBundle({
			files,
			entryPoint: bootstrapPath,
		})
		const modules = {
			...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
			...collectDynamicPackageImportProxyModules(
				files,
				bundle.modules as WorkerLoaderModules,
			),
		}
		assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: `Saved package app "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
		})
		return {
			mainModule: bundle.mainModule,
			modules,
			dependencies: await resolveDirectKodyDependenciesForEntryPoint({
				...input,
				loadedPackages: packages,
			}),
			...includeDynamicDependenciesWhenPresent(modules),
		}
	}

	const cacheKey = input.cacheKey?.trim() || null
	if (!cacheKey) {
		return await buildBundle()
	}

	return await packageAppBundleCache.getOrCreate({
		cacheKey,
		create: buildBundle,
	})
}

export function createPublishedPackageAppBundleCacheKey(input: {
	userId: string
	source: {
		id: string
		published_commit: string | null
		manifest_path: string
		source_root: string
	}
	entryPoint: string
}) {
	return createPublishedPackageCacheKey({
		userId: input.userId,
		source: input.source,
		entryPoint: input.entryPoint,
	})
}
