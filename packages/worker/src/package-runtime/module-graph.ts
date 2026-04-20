import { createWorker } from '@cloudflare/worker-bundler'
import { parse, type Node } from 'acorn'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
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

const runtimeModulePath = '.__kody_virtual__/runtime.js'
const rootSourcePrefix = '.__kody_root__'
const packageSourcePrefix = '.__kody_packages__'
const packageImportProxyPrefix = '.__kody_virtual__/imports'
const packageSpecifierPrefix = 'kody:@'
const packageAppBundleCache = createPublishedPackagePromiseCache<{
	mainModule: string
	modules: WorkerLoaderModules
}>()

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
}

type KodyPackageSpecifier = {
	kodyId: string
	exportName: string
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

function parsePackageSpecifier(specifier: string): KodyPackageSpecifier {
	if (!specifier.startsWith(packageSpecifierPrefix)) {
		throw new Error(`Unsupported Kody package specifier "${specifier}".`)
	}
	const trimmed = specifier.slice(packageSpecifierPrefix.length)
	const separator = trimmed.indexOf('/')
	if (separator === -1) {
		return {
			kodyId: trimmed.trim(),
			exportName: '.',
		}
	}
	return {
		kodyId: trimmed.slice(0, separator).trim(),
		exportName: trimmed.slice(separator + 1).trim(),
	}
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

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as Node & {
			source?: { type?: string; value?: unknown; start?: number; end?: number }
			start?: number
			end?: number
			expression?: unknown
		}
		if (
			(typedNode.type === 'ImportDeclaration' ||
				typedNode.type === 'ExportAllDeclaration' ||
				typedNode.type === 'ExportNamedDeclaration') &&
			typedNode.source?.type === 'Literal' &&
			typeof typedNode.source.value === 'string' &&
			typeof typedNode.source.start === 'number' &&
			typeof typedNode.source.end === 'number'
		) {
			nodes.push({
				start: typedNode.source.start,
				end: typedNode.source.end,
				specifier: typedNode.source.value,
			})
		}
		if (typedNode.type === 'ImportExpression') {
			const sourceNode = typedNode.source
			if (
				sourceNode &&
				typeof sourceNode === 'object' &&
				'type' in sourceNode &&
				(sourceNode as { type?: string }).type === 'Literal' &&
				typeof (sourceNode as { value?: unknown }).value === 'string' &&
				typeof (sourceNode as { start?: number }).start === 'number' &&
				typeof (sourceNode as { end?: number }).end === 'number'
			) {
				nodes.push({
					start: (sourceNode as { start: number }).start,
					end: (sourceNode as { end: number }).end,
					specifier: (sourceNode as { value: string }).value,
				})
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
		const program = parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'module',
		})
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
	kodyId: string,
): Promise<LoadedPackageSource & { row: SavedPackageRecord; prefix: string }> {
	const existing = state.packages.get(kodyId)
	if (existing) return existing
	const row = await getSavedPackageByKodyId(state.env.APP_DB, {
		userId: state.userId,
		kodyId,
	})
	if (!row) {
		throw new Error(`Saved package "${kodyId}" was not found for this user.`)
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
		prefix: joinPath(packageSourcePrefix, kodyId),
	}
	state.packages.set(kodyId, entry)
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
	const parsed = parsePackageSpecifier(specifier)
	const loaded = await ensurePackageLoaded(state, parsed.kodyId)
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
		paramsJson: JSON.stringify(input.params ?? null),
	})
	const bundle = await createWorker({
		files,
		entryPoint: bootstrapPath,
	})
	return {
		mainModule: bundle.mainModule,
		modules: bundle.modules as WorkerLoaderModules,
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
	return files
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
		const files = await prepareKodyGraphFiles({
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
