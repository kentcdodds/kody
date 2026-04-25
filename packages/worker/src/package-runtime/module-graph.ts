import { createWorker } from '@cloudflare/worker-bundler'
import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	parseModuleSource,
	type ModuleAstNode,
} from '#worker/module-source.ts'
import {
	normalizePackageWorkspacePath,
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
import { type RuntimeBundle } from './runtime-bundle-types.ts'

const runtimeModulePath = '.__kody_virtual__/runtime.js'
const rootSourcePrefix = '.__kody_root__'
const packageSourcePrefix = '.__kody_packages__'
const packageImportProxyPrefix = '.__kody_virtual__/imports'
const packageAppBundleCache = createPublishedPackagePromiseCache<RuntimeBundle>()

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

export default runtime;
`.trim()
}

function createExecuteEntrypointSource(input: {
	modulePath: string
	paramsJson: string
}) {
	return `
import userModule from ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint() {
	const entrypoint = userModule?.default ?? userModule;
	if (typeof entrypoint !== 'function') {
		throw new Error('Kody execute modules must default export a function.');
	}
	return await entrypoint(${input.paramsJson});
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
import __default from ${JSON.stringify(input.targetPath)};
export default __default;
`.trim()
}

function sanitizeSpecifier(specifier: string) {
	return specifier.replace(/[^a-zA-Z0-9/_-]+/g, '-')
}

function collectLiteralImportNodes(source: string): Array<{
	start: number
	end: number
	specifier: string
}> {
	const nodes: Array<{ start: number; end: number; specifier: string }> = []

	function readLiteralStringNode(
		node: unknown,
	): { start: number; end: number; specifier: string } | null {
		if (node == null || typeof node !== 'object') return null
		if (!('type' in node)) return null
		const typedNode = node as {
			type?: string
			value?: unknown
			start?: number
			end?: number
			extra?: { rawValue?: unknown }
		}
		const literalValue =
			typeof typedNode.value === 'string'
				? typedNode.value
				: typeof typedNode.extra?.rawValue === 'string'
					? typedNode.extra.rawValue
					: null
		if (
			(typedNode.type === 'Literal' || typedNode.type === 'StringLiteral') &&
			typeof literalValue === 'string' &&
			typeof typedNode.start === 'number' &&
			typeof typedNode.end === 'number'
		) {
			return {
				start: typedNode.start,
				end: typedNode.end,
				specifier: literalValue,
			}
		}
		return null
	}

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as ModuleAstNode & {
			source?: { type?: string; value?: unknown; start?: number; end?: number }
			start?: number
			end?: number
			expression?: unknown
		}
		if (
			(typedNode.type === 'ImportDeclaration' ||
				typedNode.type === 'ExportAllDeclaration' ||
				typedNode.type === 'ExportNamedDeclaration')
		) {
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push(literalNode)
			}
		}
		if (typedNode.type === 'ImportExpression') {
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push(literalNode)
			}
		}
		for (const value of Object.values(
			typedNode as unknown as Record<string, unknown>,
		)) {
			if (value == null) continue
			if (typeof value === 'object') {
				visit(value)
			}
		}
	}

	try {
		const program = parseModuleSource(source)
		visit(program)
	} catch {
		return []
	}

	return nodes.sort((left, right) => left.start - right.start)
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
		state.dependencies.set(packageKey, {
			sourceId: loaded.source.id,
			publishedCommit: loaded.source.published_commit,
			kodyId: row.kodyId,
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
	const exportPath = resolvePackageExportPath({
		manifest: loaded.manifest,
		exportName: parsed.exportName,
	})
	const absoluteExportPath = joinPath(loaded.prefix, exportPath)
	const proxyPath = joinPath(
		packageImportProxyPrefix,
		`${sanitizeSpecifier(specifier)}.js`,
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
	const bundle = await createWorker({
		files,
		entryPoint: bootstrapPath,
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
		const normalizedPath = joinPath(
			rootSourcePrefix,
			normalizePackageWorkspacePath(filePath),
		)
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
		const bundle = await createWorker({
			files,
			entryPoint: bootstrapPath,
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
