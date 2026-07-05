import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageWorkspacePath,
	normalizePackageExportKey,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	createPublishedPackageCacheKey,
	createPublishedPackagePromiseCache,
} from '#worker/package-registry/published-package-cache.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from './static-kody-imports.ts'
import {
	collectDynamicImportExpressionNodes,
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
const dynamicPackageImportProxyPrefix = '.__kody_virtual__/dynamic-imports'
const dynamicPackageImportArtifactSegment = '.__kody_current__'
const dynamicPackageImportSpecifierExportName = '__kodyDynamicPackageSpecifier'
const dynamicPackageImportResolvedMarker = '__kodyDynamicPackageResolved'
const packageAppBundleCache =
	createPublishedPackagePromiseCache<RuntimeBundle>()
let cachedRuntimeModuleSource: string | null = null

async function createWorkerBundle(input: {
	files: Record<string, string>
	entryPoint: string
}) {
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
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
	sourceFiles: Record<string, string>
	rootPackage: {
		manifest: AuthoredPackageJson
		prefix: string
	} | null
	proxies: Map<string, string>
	dynamicPackageImports: Map<string, string>
	packages: Map<
		string,
		LoadedPackageSource & { row: SavedPackageRecord; prefix: string }
	>
}

function createRelativeImportSpecifier(fromPath: string, targetPath: string) {
	const fromDir = dirname(fromPath)
	const relative = relativePath(fromDir, targetPath)
	const normalized =
		relative === '.' || relative.startsWith('./') || relative.startsWith('../')
			? relative
			: `./${relative}`
	return normalized.replaceAll('\\', '/')
}

function includeDynamicDependenciesWhenPresent(modules: WorkerLoaderModules) {
	const dynamicDependencies = collectDynamicKodyDependenciesFromModules(modules)
	return dynamicDependencies.length > 0 ? { dynamicDependencies } : {}
}

function resolveRelativeModulePath(fromPath: string, specifier: string) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
		return null
	}
	return normalizeWorkspaceModulePath(joinPath(dirname(fromPath), specifier))
}

export function createRuntimeModuleSource() {
	if (cachedRuntimeModuleSource) {
		return cachedRuntimeModuleSource
	}
	// The runtime context for a single execute-call / package-app fetch is
	// kept in AsyncLocalStorage rather than a single mutable globalThis slot.
	// AsyncLocalStorage propagates through async chains so concurrent calls
	// in the same isolate cannot clobber each other's runtime view, and the
	// surrounding wrapper no longer needs a try/finally save/restore dance.
	//
	// The AsyncLocalStorage *instance* must be shared between this virtual
	// runtime module and the surrounding execute / package-app wrapper,
	// because the wrapper is the one that calls `.run(runtime, cb)` while
	// user code reads the resulting store via the exports below. We share
	// the instance through a globalThis symbol; only the *instance* lives on
	// globalThis - the per-request runtime value is held inside the ALS, so
	// concurrent requests do not stomp on each other's view.
	//
	// The exports are evaluated when the module is first imported. The
	// surrounding wrapper resolves the same AsyncLocalStorage off the
	// well-known symbol and calls \`storage.run(runtime, async () => {
	// await import(...) })\`. Optional exports still capture the initial
	// value so \`if (email) { ... }\` guards stay falsy when a wrapper
	// intentionally omits that export.
	//
	// \`kody\` is different: every execute/package runtime should provide
	// it, and Worker module loaders may evaluate this virtual module before
	// the wrapper installs the per-run store. In that preload case, expose a
	// late-bound proxy so named imports like \`import { kody } from
	// 'kody:runtime'\` still resolve against the current AsyncLocalStorage
	// store at call time instead of freezing as undefined.
	const source = `
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __globalAny = /** @type {any} */ (globalThis);
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());

export function __kodyRunInRuntime(runtime, callback) {
	return __kodyRuntimeStorage.run(runtime, callback);
}

function __kodyReadRuntimeExport(exportName) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const runtimeExport = currentRuntime?.[exportName];
	if (runtimeExport == null) {
		throw new Error(
			\`kody:runtime export "\${exportName}" is not available in this execution context.\`,
		);
	}
	return runtimeExport;
}

function __kodyRuntimeProxyLabel(exportName) {
	return \`[KodyRuntime:\${exportName}]\`;
}

function __kodyRuntimeProxyInspectionValue(exportName, property) {
	if (property === Symbol.toStringTag) return \`KodyRuntime:\${exportName}\`;
	if (property === 'then') return undefined;
	if (
		property === Symbol.iterator ||
		property === Symbol.asyncIterator
	) {
		return undefined;
	}
	if (
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString'
	) {
		return () => __kodyRuntimeProxyLabel(exportName);
	}
	if (property === 'valueOf') {
		return () => __kodyCreateRuntimeObjectProxy(exportName);
	}
	return undefined;
}

function __kodyIsRuntimeProxyInspectionProperty(property) {
	return (
		property === Symbol.toStringTag ||
		property === 'then' ||
		property === Symbol.iterator ||
		property === Symbol.asyncIterator ||
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString' ||
		property === 'valueOf'
	);
}

function __kodyCreateRuntimeObjectProxy(exportName) {
	return new Proxy({}, {
		get(_target, property) {
			const inspectionValue = __kodyRuntimeProxyInspectionValue(
				exportName,
				property,
			);
			if (inspectionValue !== undefined || __kodyIsRuntimeProxyInspectionProperty(property)) {
				return inspectionValue;
			}
			const runtimeExport = __kodyReadRuntimeExport(exportName);
			const value = runtimeExport[property];
			return typeof value === 'function' ? value.bind(runtimeExport) : value;
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport != null && property in runtimeExport;
		},
	});
}

const __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
const runtime = __kodyInitialRuntime ?? {};
const __kodyObject =
	__kodyInitialRuntime === undefined
		? __kodyCreateRuntimeObjectProxy('kody')
		: runtime.kody;

export const kody = __kodyObject;
export const storage = runtime.storage;
export const refreshAccessToken = runtime.refreshAccessToken;
export const createAuthenticatedFetch = runtime.createAuthenticatedFetch;
export const secretHeaders = runtime.secretHeaders;
export const oauthClientCredentials = runtime.oauthClientCredentials;
export const packageContext = runtime.packageContext ?? null;
export const serviceContext = runtime.serviceContext ?? null;
export const service = runtime.service ?? null;
export const packageSecrets = runtime.packageSecrets ?? null;
export const email = runtime.email ?? null;
export const workflows = runtime.workflows ?? null;
export const packages = runtime.packages ?? null;
export const events = runtime.events ?? null;

export default
	__kodyInitialRuntime === undefined
		? { ...runtime, kody: __kodyObject }
		: runtime;
`.trim()
	cachedRuntimeModuleSource = source
	return source
}

function isRuntimeModulePath(modulePath: string) {
	return (
		modulePath === runtimeModulePath ||
		modulePath.endsWith(`/${runtimeModulePath}`)
	)
}

function collectReferencedRuntimeModulePaths(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
) {
	const runtimePaths = new Set<string>(
		options?.includeDefaultRuntimePath === false ? [] : [runtimeModulePath],
	)
	for (const modulePath of Object.keys(modules)) {
		if (isRuntimeModulePath(modulePath)) {
			runtimePaths.add(modulePath)
		}
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath && isRuntimeModulePath(resolvedPath)) {
				runtimePaths.add(resolvedPath)
			}
		}
	}
	return runtimePaths
}

export function refreshKodyRuntimeModules(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
): WorkerLoaderModules {
	const refreshed: WorkerLoaderModules = { ...modules }
	for (const modulePath of collectReferencedRuntimeModulePaths(
		modules,
		options,
	)) {
		refreshed[modulePath] = createRuntimeModuleSource()
	}
	return refreshed
}

function stripKodyRuntimeModules(modules: WorkerLoaderModules) {
	let stripped: WorkerLoaderModules | null = null
	for (const modulePath of Object.keys(modules)) {
		if (!isRuntimeModulePath(modulePath)) continue
		stripped ??= { ...modules }
		delete stripped[modulePath]
	}
	return stripped ?? modules
}

function createExecuteEntrypointSource(input: { modulePath: string }) {
	return `
import userEntrypoint from ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint(input) {
	if (typeof userEntrypoint !== 'function') {
		throw new Error('Kody execute modules must default export a function.');
	}
	return await userEntrypoint(input);
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

function createDynamicPackageImportPlaceholderSource(input: {
	specifier: string
}) {
	return `
export const ${dynamicPackageImportSpecifierExportName} = ${JSON.stringify(input.specifier)};

throw new Error(
	${JSON.stringify(`Kody dynamic package import "${input.specifier}" was not resolved by the host runtime.`)},
);
`.trim()
}

function createDynamicPackageImportProxySource(input: { targetPath: string }) {
	return `
// ${dynamicPackageImportResolvedMarker}
${createPackageImportProxySource(input)}
`.trim()
}

function createComputedDynamicImportGuardSource(input: { helperName: string }) {
	return `
const ${input.helperName} = async (specifier) => {
	if (typeof specifier === 'string' && specifier.startsWith(${JSON.stringify(
		packageSpecifierPrefix,
	)})) {
		throw new Error(
			'Computed dynamic Kody package imports are unsupported. Use a string literal like import("kody:@scope/package/export") for current runtime package resolution.',
		);
	}
	return await import(specifier);
};
`.trim()
}

function createDynamicPackageImportHelperSource(input: { helperName: string }) {
	return `
const ${input.helperName} = async (specifier) => {
	return await import(specifier);
};
`.trim()
}

function createImportableEntrypointSource(input: { modulePath: string }) {
	return `
export * from ${JSON.stringify(input.modulePath)};
import * as userModule from ${JSON.stringify(input.modulePath)};
export default userModule.default;
`.trim()
}

function encodePathKey(value: string) {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

function encodePathKeyAsPath(value: string) {
	const encoded = encodePathKey(value)
	const chunks = encoded.match(/.{1,96}/g)
	return chunks?.join('/') ?? encoded
}

function decodePathKey(value: string) {
	const bytes = value.match(/[0-9a-f]{2}/gi)
	if (!bytes || bytes.join('') !== value) return null
	try {
		return new TextDecoder().decode(
			new Uint8Array(bytes.map((byte) => Number.parseInt(byte, 16))),
		)
	} catch {
		return null
	}
}

function createPackageProxyPathSegment(specifier: string) {
	const parsed = parseKodyPackageSpecifier(specifier)
	return encodePathKey(
		`${parsed.packageName}#${normalizePackageExportKey(parsed.exportName)}`,
	)
}

function createPackageSpecifierFromProxyPath(modulePath: string) {
	const normalizedPath = normalizeWorkspaceModulePath(modulePath)
	const prefix = `${dynamicPackageImportProxyPrefix}/`
	const prefixIndex = normalizedPath.indexOf(prefix)
	if (prefixIndex === -1) return null
	const encodedSegment = normalizedPath
		.slice(prefixIndex + prefix.length)
		.split('/')[0]
		?.replace(/\.js$/, '')
	if (!encodedSegment) return null
	const decoded = decodePathKey(encodedSegment)
	const separator = decoded?.indexOf('#') ?? -1
	if (!decoded || separator === -1) return null
	const packageName = decoded.slice(0, separator)
	const exportName = decoded.slice(separator + 1)
	if (!packageName.startsWith('@')) return null
	const exportSuffix =
		exportName && exportName !== '.'
			? `/${exportName.replace(/^\.?\//, '')}`
			: ''
	return `capabilities:${packageName}${exportSuffix}`
}

function resolvePackageExportSourcePath(input: {
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

function readRootPackage(sourceFiles: Record<string, string>) {
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

function isBundlerRootConfigPath(path: string) {
	return path === packageManifestPath || wranglerConfigPaths.includes(path)
}

function isBundlerRootDependencyPath(path: string) {
	return path === 'node_modules' || path.startsWith('node_modules/')
}

function normalizeWorkspaceModulePath(path: string) {
	const parts: Array<string> = []
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	return parts.join('/')
}

function resolveWorkspaceSourceFilePath(input: {
	files: Record<string, string>
	path: string
}) {
	const basePath = normalizeWorkspaceModulePath(input.path)
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.js`,
		`${basePath}.jsx`,
		`${basePath}.mts`,
		`${basePath}.cts`,
		`${basePath}.mjs`,
		`${basePath}.cjs`,
		joinPath(basePath, 'index.ts'),
		joinPath(basePath, 'index.tsx'),
		joinPath(basePath, 'index.js'),
		joinPath(basePath, 'index.jsx'),
		joinPath(basePath, 'index.mts'),
		joinPath(basePath, 'index.cts'),
		joinPath(basePath, 'index.mjs'),
		joinPath(basePath, 'index.cjs'),
	]
	const substitutionBase = basePath.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
	if (substitutionBase !== basePath) {
		candidates.push(
			`${substitutionBase}.ts`,
			`${substitutionBase}.tsx`,
			`${substitutionBase}.mts`,
			`${substitutionBase}.cts`,
			`${substitutionBase}.mjs`,
			`${substitutionBase}.cjs`,
		)
	}
	return candidates.find((candidate) => input.files[candidate] != null) ?? null
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

function collectReachableSourceFilePaths(input: {
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

async function resolveDirectKodyDependenciesForEntryPoint(input: {
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
				throw new Error(
					`Saved package "${parsed.packageName}" was not found for this user.`,
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
			}
		}),
	)
	return dependencies.sort(
		(left, right) =>
			left.kodyId.localeCompare(right.kodyId) ||
			left.sourceId.localeCompare(right.sourceId),
	)
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

function materializePublishedArtifactModules(input: {
	artifactPrefix: string
	modules: WorkerLoaderModules
}) {
	const materializedModules: Record<string, string> = {}
	for (const [modulePath, module] of Object.entries(input.modules)) {
		materializedModules[joinPath(input.artifactPrefix, modulePath)] =
			materializeArtifactModuleSource({
				modulePath,
				module,
			})
	}
	return refreshKodyRuntimeModules(materializedModules, {
		includeDefaultRuntimePath: false,
	}) as Record<string, string>
}

function isStandaloneDynamicPackageImportPlaceholder(source: string) {
	return source
		.trimStart()
		.startsWith(`export const ${dynamicPackageImportSpecifierExportName}`)
}

function readDynamicPackageImportSpecifier(input: {
	modulePath: string
	module: WorkerLoaderModules[string]
}) {
	const specifierFromProxyPath = createPackageSpecifierFromProxyPath(
		input.modulePath,
	)
	const source =
		typeof input.module === 'string'
			? input.module
			: typeof input.module.js === 'string'
				? input.module.js
				: typeof input.module.cjs === 'string'
					? input.module.cjs
					: typeof input.module.text === 'string'
						? input.module.text
						: ''
	if (!source.includes(dynamicPackageImportSpecifierExportName)) {
		if (source.includes(dynamicPackageImportResolvedMarker)) return null
		return specifierFromProxyPath
	}
	if (
		!specifierFromProxyPath &&
		!isStandaloneDynamicPackageImportPlaceholder(source)
	) {
		return null
	}
	const markerIndex = source.indexOf(dynamicPackageImportSpecifierExportName)
	const match = source.slice(markerIndex).match(/=\s*("(?:[^"\\]|\\.)*")/)
	const rawSpecifier = match?.[1]
	if (!rawSpecifier) return specifierFromProxyPath
	try {
		const specifier = JSON.parse(rawSpecifier) as unknown
		return typeof specifier === 'string' &&
			specifier.startsWith(packageSpecifierPrefix)
			? specifier
			: null
	} catch {
		return specifierFromProxyPath
	}
}

function collectDynamicPackageImportsFromModules(modules: WorkerLoaderModules) {
	return Object.entries(modules)
		.map(([modulePath, module]) => ({
			modulePath,
			specifier: readDynamicPackageImportSpecifier({ modulePath, module }),
		}))
		.filter(
			(
				entry,
			): entry is {
				modulePath: string
				specifier: string
			} => entry.specifier != null,
		)
}

function collectDynamicKodyDependenciesFromModules(
	modules: WorkerLoaderModules,
): Array<BundleArtifactDynamicDependency> {
	const dependencies = new Map<string, BundleArtifactDynamicDependency>()
	for (const { specifier } of collectDynamicPackageImportsFromModules(
		modules,
	)) {
		const parsed = parseKodyPackageSpecifier(specifier)
		dependencies.set(specifier, {
			specifier,
			packageName: parsed.packageName,
			exportName: normalizePackageExportKey(parsed.exportName),
		})
	}
	return [...dependencies.values()].sort(
		(left, right) =>
			left.packageName.localeCompare(right.packageName) ||
			left.exportName.localeCompare(right.exportName),
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

async function resolveCurrentDynamicPackageArtifact(input: {
	env: Env
	baseUrl: string
	userId: string
	specifier: string
}) {
	if (!input.userId) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" requires an authenticated user.`,
		)
	}
	const parsed = parseKodyPackageSpecifier(input.specifier)
	const row = await resolveSavedPackageImport({
		db: input.env.APP_DB,
		userId: input.userId,
		specifier: parsed,
	})
	if (!row) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" could not find saved package "${parsed.packageName}" for this user.`,
		)
	}
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: row.sourceId,
	})
	if (!loaded.source.published_commit) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" resolved saved package "${row.name}" source "${row.sourceId}", but it has no published commit.`,
		)
	}
	const exportName = normalizePackageExportKey(parsed.exportName)
	const entryPoint = resolvePackageExportPath({
		manifest: loaded.manifest,
		exportName,
	})
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: row.sourceId,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
	})
	if (loadedArtifact?.artifact) {
		return loadedArtifact.artifact
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: loaded.files,
		bundleLabel: `Dynamic Kody package import "${input.specifier}"`,
	})
	const rebuilt = await buildKodyImportableModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: loaded.files,
		entryPoint,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: loaded.source,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
		mainModule: rebuilt.mainModule,
		modules: rebuilt.modules,
		dependencies: rebuilt.dependencies,
		dynamicDependencies: rebuilt.dynamicDependencies,
		packageContext: {
			packageId: row.id,
			kodyId: row.kodyId,
			sourceId: row.sourceId,
		},
	})
	return createPublishedBundleArtifact({
		kind: 'importable-module',
		artifactName: exportName,
		sourceId: loaded.source.id,
		publishedCommit: loaded.source.published_commit,
		entryPoint,
		mainModule: rebuilt.mainModule,
		modules: rebuilt.modules,
		dependencies: rebuilt.dependencies,
		dynamicDependencies: rebuilt.dynamicDependencies,
		packageContext: {
			packageId: row.id,
			kodyId: row.kodyId,
			sourceId: row.sourceId,
		},
	})
}

function installDynamicPackageArtifactModules(input: {
	modules: WorkerLoaderModules
	modulePath: string
	specifier: string
	artifact: PublishedBundleArtifact
}) {
	const artifactPrefix = joinPath(
		dirname(input.modulePath),
		dynamicPackageImportArtifactSegment,
		encodePathKeyAsPath(
			`${input.specifier}#${input.artifact.sourceId}#${input.artifact.publishedCommit}`,
		),
	)
	for (const [artifactModulePath, module] of Object.entries(
		materializePublishedArtifactModules({
			artifactPrefix,
			modules: input.artifact.modules,
		}),
	)) {
		input.modules[artifactModulePath] = module
	}
	input.modules[input.modulePath] = createDynamicPackageImportProxySource({
		targetPath: createRelativeImportSpecifier(
			input.modulePath,
			joinPath(artifactPrefix, input.artifact.mainModule),
		),
	})
	return joinPath(artifactPrefix, input.artifact.mainModule)
}

function createDynamicPackageImportArtifactKey(input: {
	specifier: string
	artifact: PublishedBundleArtifact
}) {
	return `${input.specifier}:${input.artifact.sourceId}:${input.artifact.publishedCommit}`
}

export async function hydrateKodyRuntimeModules(input: {
	env: Env
	baseUrl: string
	userId: string
	modules: WorkerLoaderModules
}): Promise<WorkerLoaderModules> {
	const modules = refreshKodyRuntimeModules(input.modules)
	const installedArtifacts = new Map<string, string>()
	const resolvedArtifacts = new Map<
		string,
		{
			artifactKey: string
			artifact: PublishedBundleArtifact
			installedArtifactMainModule?: string
		}
	>()
	while (true) {
		let installedDynamicImport = false
		const dynamicImportEntries =
			collectDynamicPackageImportsFromModules(modules)
		const unresolvedSpecifiers = [
			...new Set(
				dynamicImportEntries
					.map((entry) => entry.specifier)
					.filter((specifier) => !resolvedArtifacts.has(specifier)),
			),
		]
		await Promise.all(
			unresolvedSpecifiers.map(async (specifier) => {
				const artifact = await resolveCurrentDynamicPackageArtifact({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					specifier,
				})
				resolvedArtifacts.set(specifier, {
					artifactKey: createDynamicPackageImportArtifactKey({
						specifier,
						artifact,
					}),
					artifact,
				})
			}),
		)
		for (const entry of dynamicImportEntries) {
			const resolved = resolvedArtifacts.get(entry.specifier)
			if (!resolved) continue
			const existingArtifactMainModule =
				resolved.installedArtifactMainModule ??
				installedArtifacts.get(resolved.artifactKey)
			if (existingArtifactMainModule) {
				modules[entry.modulePath] = createDynamicPackageImportProxySource({
					targetPath: createRelativeImportSpecifier(
						entry.modulePath,
						existingArtifactMainModule,
					),
				})
				continue
			}
			const installedArtifactMainModule = installDynamicPackageArtifactModules({
				modules,
				modulePath: entry.modulePath,
				specifier: entry.specifier,
				artifact: resolved.artifact,
			})
			resolved.installedArtifactMainModule = installedArtifactMainModule
			installedArtifacts.set(resolved.artifactKey, installedArtifactMainModule)
			installedDynamicImport = true
		}
		if (!installedDynamicImport) return refreshKodyRuntimeModules(modules)
	}
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
	for (const [filePath, content] of Object.entries(loaded.files)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		const targetPath = joinPath(entry.prefix, normalizedPath)
		if (isTypeDeclarationFilePath(normalizedPath)) {
			state.files[targetPath] = content
			continue
		}
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
	state.files[proxyPath] = createPackageImportProxySource({
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

function collectDynamicPackageImportProxyModules(
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

async function rewriteKodyImports(input: {
	state: RewriteState
	source: string
	modulePath: string
}) {
	const importNodes = collectLiteralImportNodes(input.source)
	const dynamicImportNodes = collectDynamicImportExpressionNodes(input.source)
	if (importNodes.length === 0 && dynamicImportNodes.length === 0) {
		return input.source
	}
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

export async function buildKodyModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
}) {
	const { files, packages } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
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

export async function buildKodyImportableModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
}) {
	const { files, packages } = await prepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
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

async function prepareKodyGraphFiles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
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
		})
	}
	return {
		files,
		packages: state.packages,
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
		const { files, packages } = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles: input.sourceFiles,
			entryPoint: input.entryPoint,
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

export function createPublishedBundleArtifact(input: {
	kind: BundleArtifactKind
	artifactName?: string | null
	sourceId: string
	publishedCommit: string
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
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
		dynamicDependencies: input.dynamicDependencies ?? [],
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
