import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageWorkspacePath,
	normalizePackageExportKey,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	createPublishedPackageCacheKey,
	createPublishedPackagePromiseCache,
} from '#worker/package-registry/published-package-cache.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'
import { loadPublishedBundleArtifactByIdentity } from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	collectLiteralImportNodes,
	collectLiteralImportSpecifiers,
	isBarePackageImportSpecifier,
} from './import-specifiers.ts'
import { type RuntimeBundle } from './runtime-bundle-types.ts'

const runtimeModulePath = '.__kody_virtual__/runtime.js'
const packageManifestPath = 'package.json'
const wranglerConfigPaths = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']
const rootSourcePrefix = '.__kody_root__'
const packageSourcePrefix = '.__kody_packages__'
const packageImportProxyPrefix = '.__kody_virtual__/imports'
const packageAppBundleCache =
	createPublishedPackagePromiseCache<RuntimeBundle>()

async function createWorkerBundle(input: {
	files: Record<string, string>
	entryPoint: string
}) {
	// Load the experimental worker bundler lazily so node-unit paths that only
	// import saved-package runtime helpers do not eagerly evaluate the esbuild
	// WASM bundle.
	const { createWorker } = await import('@cloudflare/worker-bundler')
	return await createWorker(input)
}

function joinPath(...parts: Array<string>) {
	return parts
		.join('/')
		.replace(/\/+/g, '/')
		.replace(/\/\.\//g, '/')
}

function dirname(filePath: string) {
	const normalized = filePath.replace(/\/+/g, '/')
	const separator = normalized.lastIndexOf('/')
	return separator === -1 ? '.' : normalized.slice(0, separator) || '.'
}

function relativePath(fromDir: string, toPath: string) {
	const fromParts = fromDir.split('/').filter(Boolean)
	const toParts = toPath.split('/').filter(Boolean)
	let sharedIndex = 0
	while (
		sharedIndex < fromParts.length &&
		sharedIndex < toParts.length &&
		fromParts[sharedIndex] === toParts[sharedIndex]
	) {
		sharedIndex += 1
	}
	const upward = fromParts.slice(sharedIndex).map(() => '..')
	const downward = toParts.slice(sharedIndex)
	return [...upward, ...downward].join('/')
}

type RewriteReplacement = {
	start: number
	end: number
	value: string
}

type RewriteState = {
	env: Env
	baseUrl: string
	userId: string
	files: Record<string, string>
	proxies: Map<string, string>
	packages: Map<
		string,
		LoadedPackageSource & { row: SavedPackageRecord; prefix: string }
	>
	dependencies: Map<string, BundleArtifactDependency>
}

function createDependencyKey(dependency: BundleArtifactDependency) {
	return `${dependency.sourceId}:${dependency.publishedCommit}:${dependency.kodyId}`
}

function rememberDependency(
	state: RewriteState,
	dependency: BundleArtifactDependency,
) {
	const key = createDependencyKey(dependency)
	const existing = state.dependencies.get(key)
	state.dependencies.set(
		key,
		existing?.packageName && !dependency.packageName
			? { ...dependency, packageName: existing.packageName }
			: dependency,
	)
}

function rememberDependencies(
	state: RewriteState,
	dependencies: Array<BundleArtifactDependency>,
) {
	for (const dependency of dependencies) {
		rememberDependency(state, dependency)
	}
}

function createRelativeImportSpecifier(fromPath: string, targetPath: string) {
	const fromDir = dirname(fromPath)
	const relative = relativePath(fromDir, targetPath)
	const normalized =
		relative.startsWith('.') || relative.startsWith('..')
			? relative
			: `./${relative}`
	return normalized.replaceAll('\\', '/')
}

function createRuntimeModuleSource() {
	return `
const runtime = globalThis.__kodyRuntime ?? {};

export const codemode = runtime.codemode;
export const params = runtime.params;
export const storage = runtime.storage;
export const refreshAccessToken = runtime.refreshAccessToken;
export const createAuthenticatedFetch = runtime.createAuthenticatedFetch;
export const agentChatTurnStream = runtime.agentChatTurnStream;
export const packageContext = runtime.packageContext ?? null;
export const serviceContext = runtime.serviceContext ?? null;
export const service = runtime.service ?? null;
export const packageSecrets = runtime.packageSecrets ?? null;
export const email = runtime.email ?? null;
export const workflows = runtime.workflows ?? null;

export default runtime;
`.trim()
}

function createExecuteEntrypointSource(input: {
	modulePath: string
	paramsJson: string
}) {
	return `
import userEntrypoint from ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint() {
	if (typeof userEntrypoint !== 'function') {
		throw new Error('Kody execute modules must default export a function.');
	}
	return await userEntrypoint(${input.paramsJson});
}
`.trim()
}

function createAppEntrypointSource(input: { modulePath: string }) {
	return `
import * as userModule from ${JSON.stringify(input.modulePath)};
export * from ${JSON.stringify(input.modulePath)};

function resolvePackageAppHandler() {
  const candidate = userModule.default ?? userModule;
  if (typeof candidate === 'function') {
    return candidate;
  }
  if (candidate && typeof candidate.fetch === 'function') {
    return candidate.fetch.bind(candidate);
  }
  if (typeof userModule.fetch === 'function') {
    return userModule.fetch;
  }
  throw new Error(
    'Kody package apps must export a fetch handler via default export or named fetch.',
  );
}

const handler = resolvePackageAppHandler();

export default {
  async fetch(request, env, ctx) {
    return await handler(request, env, ctx);
  },
};
`.trim()
}

function createPackageImportProxySource(input: { targetPath: string }) {
	return `
export * from ${JSON.stringify(input.targetPath)};
import * as __kodyPackageModule from ${JSON.stringify(input.targetPath)};
export default __kodyPackageModule.default;
`.trim()
}

function createImportableEntrypointSource(input: { modulePath: string }) {
	return `
export * from ${JSON.stringify(input.modulePath)};
import * as userModule from ${JSON.stringify(input.modulePath)};
export default userModule;
`.trim()
}

function encodePathKey(value: string) {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

function createPackageProxyPathSegment(specifier: string) {
	const parsed = parseKodyPackageSpecifier(specifier)
	return encodePathKey(
		`${parsed.packageName}#${normalizePackageExportKey(parsed.exportName)}`,
	)
}

function isBundlerRootConfigPath(path: string) {
	return path === packageManifestPath || wranglerConfigPaths.includes(path)
}

function isBundlerRootDependencyPath(path: string) {
	return path === 'node_modules' || path.startsWith('node_modules/')
}

function* iterateModuleSourceTexts(
	modules: WorkerLoaderModules,
): Generator<[modulePath: string, source: string]> {
	for (const [modulePath, module] of Object.entries(modules)) {
		if (typeof module === 'string') {
			yield [modulePath, module]
			continue
		}
		if (typeof module.js === 'string') {
			yield [modulePath, module.js]
		}
		if (typeof module.cjs === 'string') {
			yield [modulePath, module.cjs]
		}
		if (typeof module.text === 'string') {
			yield [modulePath, module.text]
		}
	}
}

function collectUnresolvedBareImports(modules: WorkerLoaderModules) {
	const unresolved = new Map<string, Set<string>>()
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const specifier of collectLiteralImportSpecifiers(source)) {
			if (!isBarePackageImportSpecifier(specifier)) continue
			let existing = unresolved.get(modulePath)
			if (!existing) {
				existing = new Set()
				unresolved.set(modulePath, existing)
			}
			existing.add(specifier)
		}
	}
	return [...unresolved.entries()].map(([modulePath, specifiers]) => ({
		modulePath,
		specifiers: [...specifiers].sort((left, right) =>
			left.localeCompare(right),
		),
	}))
}

function assertBundleHasNoUnresolvedBareImports(input: {
	modules: WorkerLoaderModules
	bundleLabel: string
}) {
	const unresolved = collectUnresolvedBareImports(input.modules)
	if (unresolved.length === 0) return
	const details = unresolved
		.map(
			(entry) =>
				`${entry.modulePath}: ${entry.specifiers
					.map((specifier) => `"${specifier}"`)
					.join(', ')}`,
		)
		.join('; ')
	throw new Error(
		`${input.bundleLabel} still contains unresolved bare package imports after bundling (${details}). Declare supported runtime dependencies in package.json and ensure checks/publish can resolve them before execution.`,
	)
}

function materializeArtifactModuleSource(input: {
	modulePath: string
	module: WorkerLoaderModules[string]
}): string {
	if (typeof input.module === 'string') {
		return input.module
	}
	if (typeof input.module.js === 'string') {
		return input.module.js
	}
	if (typeof input.module.cjs === 'string') {
		return input.module.cjs
	}
	if (typeof input.module.text === 'string') {
		return input.module.text
	}
	if (input.module.json !== undefined) {
		return JSON.stringify(input.module.json)
	}
	throw new Error(
		`Saved package published bundle module "${input.modulePath}" uses an unsupported artifact module shape for import composition.`,
	)
}

async function maybeEnsurePublishedArtifactTarget(input: {
	state: RewriteState
	specifier: string
	loaded: LoadedPackageSource & { row: SavedPackageRecord; prefix: string }
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
		kind: 'module',
		artifactName: exportName,
		entryPoint,
	})
	if (!artifact?.artifact) {
		return null
	}
	rememberDependencies(input.state, artifact.artifact.dependencies)
	const artifactPrefix = joinPath(
		input.loaded.prefix,
		'.__published_bundle__',
		encodePathKey(exportName),
	)
	for (const [modulePath, module] of Object.entries(
		artifact.artifact.modules,
	)) {
		input.state.files[joinPath(artifactPrefix, modulePath)] =
			materializeArtifactModuleSource({
				modulePath,
				module,
			})
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

async function ensurePackageLoaded(
	state: RewriteState,
	specifier: string,
): Promise<LoadedPackageSource & { row: SavedPackageRecord; prefix: string }> {
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
	if (loaded.source.published_commit) {
		rememberDependency(state, {
			sourceId: loaded.source.id,
			publishedCommit: loaded.source.published_commit,
			kodyId: row.kodyId,
			packageName: row.name,
		})
	}
	for (const [filePath, content] of Object.entries(loaded.files)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		const targetPath = joinPath(entry.prefix, normalizedPath)
		state.files[targetPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: targetPath,
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
	const loaded = await ensurePackageLoaded(state, specifier)
	const absoluteExportPath =
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
			const exportPath = resolvePackageExportPath({
				manifest: loaded.manifest,
				exportName: parsed.exportName,
			})
			return joinPath(loaded.prefix, exportPath)
		})()
	const proxyPath = joinPath(
		packageImportProxyPrefix,
		`${createPackageProxyPathSegment(specifier)}.js`,
	)
	const proxyTarget = createRelativeImportSpecifier(
		proxyPath,
		absoluteExportPath,
	)
	state.files[proxyPath] = createPackageImportProxySource({
		targetPath: proxyTarget,
	})
	state.proxies.set(specifier, proxyPath)
	return proxyPath
}

async function rewriteKodyImports(input: {
	state: RewriteState
	source: string
	modulePath: string
}) {
	const importNodes = collectLiteralImportNodes(input.source)
	if (importNodes.length === 0) return input.source
	const replacements: Array<RewriteReplacement> = []
	for (const node of importNodes) {
		if (node.specifier === 'kody:runtime') {
			replacements.push({
				start: node.start,
				end: node.end,
				value: JSON.stringify(
					createRelativeImportSpecifier(input.modulePath, runtimeModulePath),
				),
			})
			continue
		}
		if (!node.specifier.startsWith(packageSpecifierPrefix)) {
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
	return applyReplacements(input.source, replacements)
}

export async function buildKodyModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	params?: Record<string, unknown>
}) {
	const { files, dependencies } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
	})
	const normalizedEntrypoint = joinPath(
		rootSourcePrefix,
		normalizePackageWorkspacePath(input.entryPoint),
	)
	const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_execute_entry__.js')
	files[bootstrapPath] = createExecuteEntrypointSource({
		modulePath: createRelativeImportSpecifier(
			bootstrapPath,
			normalizedEntrypoint,
		),
		paramsJson: 'globalThis.__kodyRuntime?.params ?? null',
	})
	const bundle = await createWorkerBundle({
		files,
		entryPoint: bootstrapPath,
	})
	assertBundleHasNoUnresolvedBareImports({
		modules: bundle.modules as WorkerLoaderModules,
		bundleLabel: `Saved package module "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
	})
	return {
		mainModule: bundle.mainModule,
		modules: bundle.modules as WorkerLoaderModules,
		dependencies: [...dependencies.values()],
	}
}

export async function buildKodyImportableModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
}) {
	const { files, dependencies } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
	})
	const normalizedEntrypoint = joinPath(
		rootSourcePrefix,
		normalizePackageWorkspacePath(input.entryPoint),
	)
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
	assertBundleHasNoUnresolvedBareImports({
		modules: bundle.modules as WorkerLoaderModules,
		bundleLabel: `Saved package import "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
	})
	return {
		mainModule: bundle.mainModule,
		modules: bundle.modules as WorkerLoaderModules,
		dependencies: [...dependencies.values()],
	}
}

async function prepareKodyGraphFiles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
}) {
	const files: Record<string, string> = {
		[runtimeModulePath]: createRuntimeModuleSource(),
	}
	const state: RewriteState = {
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		files,
		proxies: new Map(),
		packages: new Map(),
		dependencies: new Map(),
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
		files[normalizedPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: normalizedPath,
		})
	}
	return {
		files,
		dependencies: state.dependencies,
	}
}

export async function buildKodyAppBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	cacheKey?: string | null
}) {
	const buildBundle = async () => {
		const { files, dependencies } = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles: input.sourceFiles,
		})
		const normalizedEntrypoint = joinPath(
			rootSourcePrefix,
			normalizePackageWorkspacePath(input.entryPoint),
		)
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
		assertBundleHasNoUnresolvedBareImports({
			modules: bundle.modules as WorkerLoaderModules,
			bundleLabel: `Saved package app "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
		})
		return {
			mainModule: bundle.mainModule,
			modules: bundle.modules as WorkerLoaderModules,
			dependencies: [...dependencies.values()],
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

export function createPublishedBundleArtifact(input: {
	kind: BundleArtifactKind
	artifactName?: string | null
	sourceId: string
	publishedCommit: string
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null
	serviceContext?: {
		serviceName: string
	} | null
}): PublishedBundleArtifact {
	return {
		version: 1,
		kind: input.kind,
		artifactName: input.artifactName?.trim() || null,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		entryPoint: normalizePackageWorkspacePath(input.entryPoint),
		mainModule: input.mainModule,
		modules: input.modules,
		dependencies: input.dependencies,
		packageContext: input.packageContext ?? null,
		serviceContext: input.serviceContext ?? null,
		createdAt: new Date().toISOString(),
	}
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
