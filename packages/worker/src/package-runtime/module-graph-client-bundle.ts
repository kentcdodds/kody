import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { importWorkerBundler } from '#worker/worker-bundler-modules.ts'
import {
	collectLiteralImportNodes,
	isBarePackageImportSpecifier,
} from './import-specifiers.ts'
import {
	resolveWorkspaceSourceFilePath,
	wranglerConfigPaths,
} from './module-graph-paths.ts'
import {
	collectReachableSourceFilePaths,
	isBundlerRootConfigPath,
	isBundlerRootDependencyPath,
	readRootPackage,
} from './module-graph-workspace.ts'
import { type RuntimeBundle } from './runtime-bundle-types.ts'
import { iterateModuleSourceTexts } from './runtime-source-modules.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

/**
 * Browser-side bundle for `package.json#kody.app.client`.
 *
 * The Worker `app` bundle rewrites `kody:` imports into runtime proxies that
 * only exist inside the package-app isolate. Nothing of the sort exists in a
 * browser, so the client graph is bundled from the raw workspace files with
 * esbuild's browser platform and any server-only specifier is rejected with a
 * message that names the file. The output is a single ESM module whose file
 * name carries a content hash, so the platform can serve it with immutable
 * cache headers and authors read the URL from `packageContext.clientModuleUrl`
 * instead of hardcoding it.
 */

const clientModuleHashLength = 16

/**
 * Specifier schemes that only resolve inside the Worker runtime. `kody:` is
 * the package runtime, `cloudflare:` is workerd, `node:` is nodejs_compat.
 */
const serverOnlySpecifierPrefixes = ['kody:', 'cloudflare:', 'node:'] as const

function isServerOnlySpecifier(specifier: string) {
	return serverOnlySpecifierPrefixes.some((prefix) =>
		specifier.startsWith(prefix),
	)
}

function isStylesheetSpecifier(specifier: string) {
	return /\.css(?:[?#].*)?$/i.test(specifier)
}

function formatSpecifierList(specifiers: Iterable<string>) {
	return [...new Set(specifiers)]
		.sort((left, right) => left.localeCompare(right))
		.map((specifier) => `"${specifier}"`)
		.join(', ')
}

function buildPackageAppClientModuleName(hash: string) {
	return `client.${hash}.js`
}

export const packageAppClientModuleNamePattern =
	/^client\.[A-Za-z0-9_-]{8,}\.js$/

type ClientGraphProblem = {
	modulePath: string
	specifiers: Array<string>
}

function collectServerOnlyImports(input: {
	files: Record<string, string>
	reachable: Set<string>
}) {
	const serverOnly: Array<ClientGraphProblem> = []
	const stylesheets: Array<ClientGraphProblem> = []
	for (const modulePath of [...input.reachable].sort()) {
		if (isTypeDeclarationFilePath(modulePath)) continue
		const source = input.files[modulePath]
		if (source == null) continue
		const serverOnlySpecifiers = new Set<string>()
		const stylesheetSpecifiers = new Set<string>()
		for (const node of collectLiteralImportNodes(source)) {
			if (isServerOnlySpecifier(node.specifier)) {
				serverOnlySpecifiers.add(node.specifier)
			} else if (isStylesheetSpecifier(node.specifier)) {
				stylesheetSpecifiers.add(node.specifier)
			}
		}
		if (serverOnlySpecifiers.size > 0) {
			serverOnly.push({
				modulePath,
				specifiers: [...serverOnlySpecifiers],
			})
		}
		if (stylesheetSpecifiers.size > 0) {
			stylesheets.push({
				modulePath,
				specifiers: [...stylesheetSpecifiers],
			})
		}
	}
	return { serverOnly, stylesheets }
}

function formatProblems(problems: Array<ClientGraphProblem>) {
	return problems
		.map(
			(problem) =>
				`${problem.modulePath}: ${formatSpecifierList(problem.specifiers)}`,
		)
		.join('; ')
}

function assertClientGraphIsBrowserSafe(input: {
	files: Record<string, string>
	reachable: Set<string>
	bundleLabel: string
}) {
	const { serverOnly, stylesheets } = collectServerOnlyImports(input)
	if (serverOnly.length > 0) {
		throw new Error(
			`${input.bundleLabel} imports server-only modules that cannot run in the browser (${formatProblems(
				serverOnly,
			)}). ` +
				'Keep kody:runtime, kody:@ package imports, cloudflare:*, and node:* in the Worker entry (kody.app.entry) and expose what the page needs over fetch or the realtime facet.',
		)
	}
	if (stylesheets.length > 0) {
		throw new Error(
			`${input.bundleLabel} imports stylesheets (${formatProblems(
				stylesheets,
			)}), which the client bundle does not process. ` +
				'Put the .css file in the kody.app.assets directory and link it from the page, or inline the styles.',
		)
	}
}

function collectBrowserBundleFiles(input: {
	sourceFiles: Record<string, string>
	reachable: Set<string>
}) {
	const files: Record<string, string> = {}
	for (const [filePath, content] of Object.entries(input.sourceFiles)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		// Wrangler config would flip the bundler into nodejs_compat mode; the
		// browser bundle must always target the browser platform.
		if (wranglerConfigPaths.includes(normalizedPath)) continue
		if (
			isBundlerRootConfigPath(normalizedPath) ||
			isBundlerRootDependencyPath(normalizedPath) ||
			input.reachable.has(normalizedPath)
		) {
			files[normalizedPath] = content
		}
	}
	return files
}

function assertBrowserBundleHasNoUnresolvedImports(input: {
	modules: WorkerLoaderModules
	bundleLabel: string
}) {
	const serverOnly = new Set<string>()
	const unresolved = new Set<string>()
	for (const [, source] of iterateModuleSourceTexts(input.modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			if (isServerOnlySpecifier(node.specifier)) {
				serverOnly.add(node.specifier)
			} else if (isBarePackageImportSpecifier(node.specifier)) {
				unresolved.add(node.specifier)
			}
		}
	}
	if (serverOnly.size > 0) {
		throw new Error(
			`${input.bundleLabel} still references server-only modules after bundling (${formatSpecifierList(
				serverOnly,
			)}). A dependency pulled them in; pick a browser-compatible package or move that code to the Worker entry.`,
		)
	}
	if (unresolved.size > 0) {
		throw new Error(
			`${input.bundleLabel} still contains unresolved bare package imports after bundling (${formatSpecifierList(
				unresolved,
			)}). Declare the dependency in package.json so publish can install it, or import it from a full https:// URL the browser can load.`,
		)
	}
}

export async function buildKodyAppClientBundle(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
}): Promise<RuntimeBundle> {
	const bundleLabel = `Saved package app client "${normalizePackageWorkspacePath(
		input.entryPoint,
	)}" bundle`
	const entryPoint = resolveWorkspaceSourceFilePath({
		files: input.sourceFiles,
		path: input.entryPoint,
	})
	if (!entryPoint) {
		throw new Error(
			`${bundleLabel} entry was not found in the package source. Point package.json#kody.app.client at a .ts, .tsx, .js, or .jsx file in the repo.`,
		)
	}
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage: readRootPackage(input.sourceFiles),
	})
	assertClientGraphIsBrowserSafe({
		files: input.sourceFiles,
		reachable,
		bundleLabel,
	})
	const files = collectBrowserBundleFiles({
		sourceFiles: input.sourceFiles,
		reachable,
	})
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createWorker } = await importWorkerBundler()
	const bundle = await createWorker({
		files,
		entryPoint,
		bundle: true,
		target: 'es2022',
	})
	const bundledModule = bundle.modules[bundle.mainModule]
	const source =
		typeof bundledModule === 'string'
			? bundledModule
			: typeof bundledModule?.js === 'string'
				? bundledModule.js
				: null
	if (source == null) {
		throw new Error(
			`${bundleLabel} produced no JavaScript output for "${entryPoint}".`,
		)
	}
	const modules: WorkerLoaderModules = { [bundle.mainModule]: source }
	assertBrowserBundleHasNoUnresolvedImports({ modules, bundleLabel })
	const hash = (await sha256Base64Url(source)).slice(0, clientModuleHashLength)
	const mainModule = buildPackageAppClientModuleName(hash)
	return {
		mainModule,
		modules: { [mainModule]: source },
		dependencies: [],
	}
}
