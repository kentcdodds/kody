import { isPlatformAccountStableUserId } from '#worker/package-registry/scope-grants.ts'
import { loadLocalExecuteRuntimeSupport } from '#worker/local-execute-runtime-support-load.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { collectDynamicImportExpressionNodes } from './import-specifiers.ts'
import { prepareKodyGraphFiles } from './module-graph-import-rewriting.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageSourcePrefix,
	resolveRelativeModulePath,
	rootSourcePrefix,
	runtimeModulePath,
} from './module-graph-paths.ts'
import {
	createPackageImportProxySource,
	createRuntimeModuleReexportSource,
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
	parsePackageRuntimeModulePathPackageId,
} from './runtime-source-modules.ts'
import { collectStaticKodyPackageImportsFromFiles } from './static-kody-imports.ts'

/** Host module name the CLI registers in local workerd (`localWorkerModuleNames.runtime`). */
export const localExecuteHostRuntimeModuleName = 'kody:runtime'

export type LocalExecutePackageModule = {
	name: string
	esModule: string
}

export type LocalExecutePackageGraph = {
	modules: Array<LocalExecutePackageModule>
	imports: Array<string>
	warnings: Array<string>
}

export class LocalExecutePackageGraphError extends Error {
	readonly code:
		| 'package_import_unresolved'
		| 'package_import_unpublished'
		| 'unsupported_dynamic_package_import'

	constructor(
		code: LocalExecutePackageGraphError['code'],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'LocalExecutePackageGraphError'
		this.code = code
	}
}

/**
 * Resolve published, stamped `kody:@…` modules for CLI `execute --local`
 * embedding. Does not execute the user module and does not claim a dynamic
 * worker day — callers meter this as an Open API prep operation.
 */
export async function buildLocalExecutePackageGraph(input: {
	env: Env
	baseUrl: string
	userId: string
	code: string
}): Promise<LocalExecutePackageGraph> {
	assertNoLiteralDynamicSavedPackageImports(input.code)

	const sourceFiles = { 'entry.ts': input.code }
	const staticImports = uniqueSpecifiers(
		collectStaticKodyPackageImportsFromFiles(sourceFiles).map(
			(entry) => entry.specifier,
		),
	)
	if (staticImports.length === 0) {
		return { modules: [], imports: [], warnings: [] }
	}

	let prepared: Awaited<ReturnType<typeof prepareKodyGraphFiles>>
	try {
		const allowPlatformScopes = await isPlatformAccountStableUserId(
			input.env.APP_DB,
			input.userId,
		)
		prepared = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles,
			entryPoint: 'entry.ts',
			allowPlatformScopes,
		})
	} catch (error) {
		throw mapPrepareFailure(error, staticImports)
	}

	const {
		rewriteInlinedLocalExecuteBundleSource,
		createLocalExecuteRuntimeShimSource,
		createLocalExecutePackageRuntimeModuleSource,
	} = await loadLocalExecuteRuntimeSupport()

	const modulesByName = new Map<string, string>()
	const runtimeModulePaths: Array<string> = []
	for (const [modulePath, source] of Object.entries(prepared.files)) {
		const normalized = normalizeWorkspaceModulePath(modulePath)
		if (shouldOmitPreparedModule(normalized)) continue
		if (isKodyRuntimeModulePath(normalized)) {
			runtimeModulePaths.push(normalized)
			continue
		}
		const packageRuntimeId = parsePackageRuntimeModulePathPackageId(normalized)
		modulesByName.set(
			normalized,
			packageRuntimeId != null
				? createLocalExecutePackageRuntimeModuleSource(packageRuntimeId)
				: source,
		)
	}

	// workerd path-joins bare `kody:runtime` from path-like module names
	// (`.__kody_virtual__/…`, `.__published_bundle__/…`). Put the CapabilityProxy
	// shim once at the primary runtime path with a relative import to the host
	// `kody:runtime` module; nested published-bundle copies re-export that root
	// (same shape as cloud stamp hydration).
	const primaryRuntimePath =
		pickLocalExecutePrimaryRuntimePath(runtimeModulePaths)
	for (const modulePath of runtimeModulePaths) {
		modulesByName.set(
			modulePath,
			modulePath === primaryRuntimePath
				? createLocalExecuteRuntimeShimSource(modulePath)
				: createRuntimeModuleReexportSource(modulePath, primaryRuntimePath),
		)
	}

	for (const specifier of staticImports) {
		const proxyPath = joinPath(
			packageImportProxyPrefix,
			`${createPackageProxyPathSegment(specifier)}.js`,
		)
		const proxySource = prepared.files[proxyPath]
		if (typeof proxySource !== 'string') {
			throw new LocalExecutePackageGraphError(
				'package_import_unresolved',
				`Could not resolve saved package import ${specifier} for local execute.`,
			)
		}
		const targetPath = readProxyTargetAbsolutePath(proxyPath, proxySource)
		if (targetPath == null || !targetPath.includes('/.__published_bundle__/')) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} has no published importable-module artifact for local execute. Publish the package export, then retry.`,
			)
		}
		if (!modulesByName.has(targetPath)) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} is missing its published artifact modules for local execute.`,
			)
		}
		// Alias the exact `kody:@…` specifier the CLI embeds next to user code.
		// Use an unmetered re-export so local workerd does not need cloud
		// static-call metering helpers from the shared runtime. Target must be
		// relative: workerd treats `.__kody_packages__/…` as a relative-path
		// reference from the alias module, not an exact module-name lookup.
		modulesByName.set(
			specifier,
			createPackageImportProxySource({
				targetPath: createRelativeImportSpecifier(specifier, targetPath),
			}),
		)
	}

	// Dropbox-style published bundles inline `.__kody_virtual__/runtime.js`.
	// Rewrite those preambles onto the CapabilityProxy shim so --local does
	// not depend on cloud's ALS preload (kody#2810 residual / inlined CAF).
	for (const [modulePath, source] of modulesByName.entries()) {
		if (isKodyRuntimeModulePath(modulePath)) continue
		if (parsePackageRuntimeModulePathPackageId(modulePath) != null) continue
		const rewritten = rewriteInlinedLocalExecuteBundleSource({
			modulePath,
			source,
			primaryRuntimePath,
		})
		if (rewritten.rewritten) {
			modulesByName.set(modulePath, rewritten.source)
		}
	}

	const modules = [...modulesByName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, esModule]) => ({ name, esModule }))

	return {
		modules,
		imports: staticImports,
		warnings: [],
	}
}

function assertNoLiteralDynamicSavedPackageImports(code: string) {
	for (const node of collectDynamicImportExpressionNodes(code)) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			throw new LocalExecutePackageGraphError(
				'unsupported_dynamic_package_import',
				`Local execute cannot bind literal dynamic import(${JSON.stringify(node.literalSpecifier)}) yet — use a static import.`,
			)
		}
	}
}

function uniqueSpecifiers(specifiers: ReadonlyArray<string>) {
	return [...new Set(specifiers)].sort((left, right) =>
		left.localeCompare(right),
	)
}

function shouldOmitPreparedModule(modulePath: string) {
	if (modulePath === 'package.json') return true
	if (modulePath.startsWith(`${rootSourcePrefix}/`)) return true
	if (isKodyPublicRuntimeModulePath(modulePath)) return true
	// Cloud import proxies are replaced by `kody:@…` aliases in the response.
	if (modulePath.startsWith(`${packageImportProxyPrefix}/`)) return true
	if (isKodyRuntimeModulePath(modulePath)) return false
	if (parsePackageRuntimeModulePathPackageId(modulePath) != null) return false
	// Prefer published importable-module artifacts only — omit live package
	// source and npm dependency copies from a rebuild miss.
	if (modulePath.includes('/.__published_bundle__/')) return false
	if (modulePath.startsWith(`${packageSourcePrefix}/`)) return true
	if (modulePath.startsWith('.__kody_virtual__/')) return false
	return true
}

function readProxyTargetAbsolutePath(proxyPath: string, proxySource: string) {
	const match =
		/export\s*\*\s*from\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			proxySource,
		)
	if (!match?.[1]) return null
	let targetSpecifier: string
	try {
		targetSpecifier = JSON.parse(
			match[1].startsWith("'")
				? `"${match[1].slice(1, -1).replaceAll('"', '\\"')}"`
				: match[1],
		) as string
	} catch {
		return null
	}
	if (targetSpecifier.startsWith('./') || targetSpecifier.startsWith('../')) {
		return resolveRelativeModulePath(proxyPath, targetSpecifier)
	}
	return normalizeWorkspaceModulePath(targetSpecifier)
}

function mapPrepareFailure(
	error: unknown,
	imports: ReadonlyArray<string>,
): LocalExecutePackageGraphError {
	if (error instanceof LocalExecutePackageGraphError) return error
	const message =
		error instanceof Error
			? error.message
			: 'Could not resolve package imports.'
	const importList = imports.join(', ')
	if (/not found/i.test(message) || /was not found/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
			{ cause: error },
		)
	}
	if (/platform packages are not runnable/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			message,
			{ cause: error },
		)
	}
	if (/sealed secret provider/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			message,
			{ cause: error },
		)
	}
	if (
		/unsupported kody package specifier/i.test(message) ||
		/nested dynamic import/i.test(message)
	) {
		return new LocalExecutePackageGraphError(
			'unsupported_dynamic_package_import',
			message,
			{ cause: error },
		)
	}
	return new LocalExecutePackageGraphError(
		'package_import_unresolved',
		`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
		{ cause: error },
	)
}

/**
 * Local workerd supplies `kody:runtime` (CapabilityProxy bridge). Stamped
 * package moka published-bundle copies re-export one shim (and one relative hop to
 * host `kody:runtime`). Artifact-only graphs fall back to the shortest path.
 */
export function pickLocalExecutePrimaryRuntimePath(
	paths: ReadonlyArray<string>,
) {
	const normalized = [
		...new Set(paths.map((path) => normalizeWorkspaceModulePath(path))),
	]
	if (normalized.length === 0) return runtimeModulePath
	if (normalized.includes(runtimeModulePath)) return runtimeModulePath
	normalized.sort(
		(left, right) => left.length - right.length || left.localeCompare(right),
	)
	return normalized[0] ?? runtimeModulePath
}
