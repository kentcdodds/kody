import { getDeclaredPackageAppRuntime } from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type PackageAppRuntime,
} from '#worker/package-registry/types.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import {
	collectReachableSourceFilePaths,
	readRootPackage,
} from './module-graph-workspace.ts'
import { isRemixSpecifier } from './package-app-remix-subpaths.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

/**
 * Stable `import.meta.url` for the package-app server bundle.
 *
 * workerd leaves `import.meta.url` empty inside Worker Loader modules, and
 * `clientEntry()` throws on an empty entry id, so the Remix idiom
 * `clientEntry(import.meta.url, Component)` would never survive SSR. The
 * server bundle is one module and the browser bundle is one module, so the
 * id only has to be non-empty: Remix's default resolution keeps the
 * component's export name and the browser `run({ loadModule })` looks the
 * export up in its own module namespace, ignoring the href.
 */
export const packageAppServerModuleUrl = 'kody:app'

/** JSX import source every Remix package app compiles against. */
export const packageAppRemixJsxImportSource = 'remix/ui'

/**
 * Whether any module reachable from the entry statically imports
 * `remix/<subpath>`; the inference rule for an undeclared `kody.app.runtime`.
 */
export function entryGraphImportsRemix(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
}) {
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackage: readRootPackage(input.sourceFiles),
	})
	for (const modulePath of reachable) {
		if (isTypeDeclarationFilePath(modulePath)) continue
		const source = input.sourceFiles[modulePath]
		if (source == null) continue
		for (const node of collectLiteralImportNodes(source)) {
			if (isRemixSpecifier(node.specifier)) return true
		}
	}
	return false
}

/**
 * The runtime a package app's `entry` runs under: the declared
 * `kody.app.runtime`, else `remix` when the entry graph imports Remix, else
 * `fetch`. Publish checks, the bundle builders, and the docs all use this
 * one rule so a manifest that omits the field behaves the same everywhere.
 */
export function resolvePackageAppRuntime(input: {
	/** `null` when the snapshot has no parseable `package.json`. */
	manifest: AuthoredPackageJson | null
	sourceFiles: Record<string, string>
	entryPoint: string
}): PackageAppRuntime {
	const declared = input.manifest
		? getDeclaredPackageAppRuntime(input.manifest)
		: null
	if (declared) return declared
	return entryGraphImportsRemix(input) ? 'remix' : 'fetch'
}

type EsbuildInitialOptionsBuild = {
	initialOptions: { keepNames?: boolean }
}

/**
 * Remix resolves a hydrated component's browser export from
 * `component.name` when the entry id carries no `#ExportName`. Bundling the
 * whole app into one scope makes esbuild rename colliding identifiers
 * (`export const Counter = clientEntry(url, function Counter …)` becomes
 * `Counter2`), which would send the browser looking for an export that does
 * not exist. `keepNames` pins `.name` to the source name. The runtime
 * bundler does not expose the option, so a plugin sets it on the build's
 * initial options during setup — the documented way for an esbuild plugin
 * to adjust options.
 */
export function createKeepNamesPlugin() {
	return {
		name: 'kody-package-app-keep-names',
		setup(build: EsbuildInitialOptionsBuild) {
			build.initialOptions.keepNames = true
		},
	}
}

export type PackageAppRemixBundleOptions = {
	jsx: 'automatic'
	jsxImportSource: string
	define?: Record<string, string>
	__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: Array<unknown>
}

/**
 * Bundler options for a Remix package app's server graph: JSX compiles
 * against `remix/ui` without a per-file pragma, `import.meta.url` is pinned
 * so `clientEntry(import.meta.url, …)` yields a usable hydration id, and
 * component names survive bundling so that id resolves to the right browser
 * export. A `@jsxImportSource` pragma in a file still overrides the JSX
 * default, as it does anywhere esbuild runs.
 */
export function createPackageAppRemixServerBundleOptions(): PackageAppRemixBundleOptions {
	return {
		jsx: 'automatic',
		jsxImportSource: packageAppRemixJsxImportSource,
		define: { 'import.meta.url': JSON.stringify(packageAppServerModuleUrl) },
		__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
			createKeepNamesPlugin(),
		],
	}
}

/**
 * Bundler options for the browser graph of a Remix package app. The browser
 * has a real `import.meta.url` (the fingerprinted module URL), so only the
 * JSX default applies.
 */
export function createPackageAppRemixClientBundleOptions(): PackageAppRemixBundleOptions {
	return {
		jsx: 'automatic',
		jsxImportSource: packageAppRemixJsxImportSource,
	}
}
