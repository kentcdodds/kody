import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
} from './module-graph-paths.ts'

/**
 * Published importable-module artifacts sometimes esbuild-inline
 * `.__kody_virtual__/runtime.js` (and the per-package runtime facade) into the
 * bundle. Those inlined helpers capture
 * `AsyncLocalStorage.getStore()` at module evaluation time via
 * `__kodyOptionalRuntimeFunctionExport`. Cloud execute imports the bundle
 * inside `__kodyRunInRuntime`, so the store is populated; CLI `execute --local`
 * evaluates modules without that ALS entry, leaving `createAuthenticatedFetch`
 * (and siblings) as permanent `undefined`.
 *
 * Google-style artifacts keep an external `./.__kody_virtual__/runtime.js`
 * import and already work under --local via the CapabilityProxy shim. Dropbox-
 * style inlined artifacts need this rewrite: strip the inlined virtual runtime
 * sections and bind the same shim factories the external-import path uses.
 */

const virtualRuntimeMarker = '// virtual:.__kody_virtual__/runtime.js'
const virtualPackageRuntimeMarker =
	'// virtual:.__kody_virtual__/package-runtime/'
const virtualRootMarker = '// virtual:.__kody_root__/'

const optionalCreateAuthenticatedFetchPattern =
	/__kodyOptionalRuntimeFunctionExport\(\s*["']createAuthenticatedFetch["']\s*\)/

const packageBoundStoragePattern =
	/__kodyCreatePackageBoundStorage\(\s*["']([^"']+)["']\s*\)/

export function moduleSourceHasInlinedKodyRuntime(source: string) {
	return (
		source.includes(virtualRuntimeMarker) ||
		optionalCreateAuthenticatedFetchPattern.test(source)
	)
}

/**
 * When `source` inlines the virtual runtime, replace that preamble with
 * imports/bindings from the local-execute primary runtime shim. Returns the
 * original source when no rewrite is needed or the cut point cannot be found
 * safely (CLI ALS install remains the fallback for those shapes).
 */
export function rewriteInlinedLocalExecuteBundleSource(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
}): { source: string; rewritten: boolean; packageId: string | null } {
	if (!moduleSourceHasInlinedKodyRuntime(input.source)) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const cutIndex = findAuthorCodeCutIndex(input.source)
	if (cutIndex == null) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const preambleSource = input.source.slice(0, cutIndex)
	const packageId = readInlinedPackageId(preambleSource)
	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const preamble = createInlinedRuntimeReplacementPreamble({
		relativeShimSpecifier: relativeShim,
		packageId,
	})
	return {
		source: `${preamble}\n\n${input.source.slice(cutIndex)}`,
		rewritten: true,
		packageId,
	}
}

function findAuthorCodeCutIndex(source: string) {
	const rootIndex = source.indexOf(virtualRootMarker)
	if (rootIndex !== -1) return rootIndex

	// Artifacts that inline runtime but do not use the `.__kody_root__/` banner
	// still usually keep a package-runtime virtual section. Cut at the first
	// non-runtime virtual banner after that section, if any.
	const packageRuntimeIndex = source.indexOf(virtualPackageRuntimeMarker)
	if (packageRuntimeIndex === -1) return null
	const afterPackageRuntime = source.indexOf(
		'\n// virtual:',
		packageRuntimeIndex + virtualPackageRuntimeMarker.length,
	)
	if (afterPackageRuntime === -1) return null
	const nextBanner = source.slice(afterPackageRuntime + 1)
	if (
		nextBanner.startsWith(virtualRuntimeMarker.slice(3)) ||
		nextBanner.startsWith(virtualPackageRuntimeMarker.slice(3))
	) {
		return null
	}
	return afterPackageRuntime + 1
}

function readInlinedPackageId(preambleSource: string) {
	const match = packageBoundStoragePattern.exec(preambleSource)
	return match?.[1] ?? null
}

function createInlinedRuntimeReplacementPreamble(input: {
	relativeShimSpecifier: string
	packageId: string | null
}) {
	const shim = JSON.stringify(input.relativeShimSpecifier)
	if (input.packageId) {
		const packageIdLiteral = JSON.stringify(input.packageId)
		return `
import {
	kody,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	email,
	workflows,
	packages,
	events,
	__kodyCreatePackageBoundAuthenticatedFetch,
	__kodyCreatePackageBoundStorage,
	__kodyCreatePackageBoundSecrets,
} from ${shim};

var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch(${packageIdLiteral});
var packageStorage = __kodyCreatePackageBoundStorage(${packageIdLiteral});
var packageSecrets = __kodyCreatePackageBoundSecrets(${packageIdLiteral});
`.trim()
	}

	return `
import {
	kody,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	packageStorage,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
} from ${shim};
`.trim()
}
