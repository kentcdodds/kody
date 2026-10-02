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
 * / package-runtime sections and bind the same shim factories the
 * external-import path uses. Author modules (including `.__kody_root__/`
 * dependencies that appear before or after those sections) are preserved.
 */

const virtualRuntimeMarker = '// virtual:.__kody_virtual__/runtime.js'
const virtualPackageRuntimeMarker =
	'// virtual:.__kody_virtual__/package-runtime/'
const virtualBannerPattern = /^\/\/ virtual:[^\n]*/gm

const optionalCreateAuthenticatedFetchPattern =
	/__kodyOptionalRuntimeFunctionExport\(\s*["']createAuthenticatedFetch["']\s*\)/

const packageBoundStoragePattern =
	/__kodyCreatePackageBoundStorage\(\s*["']([^"']+)["']\s*\)/g

export function moduleSourceHasInlinedKodyRuntime(source: string) {
	return (
		source.includes(virtualRuntimeMarker) ||
		optionalCreateAuthenticatedFetchPattern.test(source)
	)
}

/**
 * When `source` inlines the virtual runtime, replace those sections with
 * imports/bindings from the local-execute primary runtime shim. Returns the
 * original source when no rewrite is needed or the runtime sections cannot be
 * identified safely (CLI ALS install remains the fallback for those shapes).
 */
export function rewriteInlinedLocalExecuteBundleSource(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
}): { source: string; rewritten: boolean; packageId: string | null } {
	if (!moduleSourceHasInlinedKodyRuntime(input.source)) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const sections = splitVirtualSections(input.source)
	const removable = sections.filter((section) =>
		isRemovableRuntimeSection(section.banner),
	)
	if (removable.length === 0) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const preambleSource = removable.map((section) => section.source).join('')
	const retained = sections
		.filter((section) => !isRemovableRuntimeSection(section.banner))
		.map((section) => section.source)
		.join('')
	const packageId = readInlinedPackageId(preambleSource)
	const bindingNames = readInlinedBindingNames(preambleSource)
	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const preamble = createInlinedRuntimeReplacementPreamble({
		relativeShimSpecifier: relativeShim,
		packageId,
		bindingNames,
		retainedAuthorSource: retained,
	})

	const insertAt = removable[0]?.start ?? 0
	const before = input.source.slice(0, insertAt)
	// Prefer inserting the shim where the first removed runtime section lived
	// so leading non-runtime author content (rare) stays ahead of the shim.
	const leadingAuthor = before
	return {
		source: `${leadingAuthor}${preamble}\n\n${retained}`,
		rewritten: true,
		packageId,
	}
}

type VirtualSection = {
	banner: string | null
	start: number
	end: number
	source: string
}

function splitVirtualSections(source: string): Array<VirtualSection> {
	const matches = [...source.matchAll(virtualBannerPattern)]
	if (matches.length === 0) {
		return [{ banner: null, start: 0, end: source.length, source }]
	}
	const sections: Array<VirtualSection> = []
	const firstIndex = matches[0]?.index ?? 0
	if (firstIndex > 0) {
		sections.push({
			banner: null,
			start: 0,
			end: firstIndex,
			source: source.slice(0, firstIndex),
		})
	}
	for (let i = 0; i < matches.length; i += 1) {
		const match = matches[i]
		if (!match) continue
		const start = match.index ?? 0
		const end = matches[i + 1]?.index ?? source.length
		sections.push({
			banner: match[0] ?? null,
			start,
			end,
			source: source.slice(start, end),
		})
	}
	return sections
}

function isRemovableRuntimeSection(banner: string | null) {
	if (!banner) return false
	return (
		banner === virtualRuntimeMarker ||
		banner.startsWith(virtualPackageRuntimeMarker)
	)
}

/**
 * Prefer the last package-bound storage id in the removed preamble. Published
 * graphs can inline dependency package-runtime facades before the root
 * package's facade; the root (last) id is the one author entry code should use.
 */
function readInlinedPackageId(preambleSource: string) {
	const matches = [...preambleSource.matchAll(packageBoundStoragePattern)]
	return matches.at(-1)?.[1] ?? null
}

function readAssignmentBindingName(preambleSource: string, rhsPattern: RegExp) {
	const match = new RegExp(
		`(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${rhsPattern.source}`,
	).exec(preambleSource)
	return match?.[1] ?? null
}

function readLastAssignmentBindingName(
	preambleSource: string,
	rhsPattern: RegExp,
) {
	const matches = [
		...preambleSource.matchAll(
			new RegExp(
				`(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${rhsPattern.source}`,
				'g',
			),
		),
	]
	return matches.at(-1)?.[1] ?? null
}

/**
 * Esbuild renames colliding inlined bindings (`packageStorage` →
 * `packageStorage2`). Author code after the cut references those renamed
 * identifiers, so the replacement preamble must reuse the same names.
 */
export function readInlinedBindingNames(preambleSource: string) {
	const packageStorage =
		readAssignmentBindingName(
			preambleSource,
			/__kodyCreatePackageBoundStorage\s*\(/,
		) ?? 'packageStorage'
	const packageSecrets =
		readAssignmentBindingName(
			preambleSource,
			/__kodyCreatePackageBoundSecrets\s*\(/,
		) ?? 'packageSecrets'
	const createAuthenticatedFetch =
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']createAuthenticatedFetch["']/,
		) ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyCreatePackageBoundAuthenticatedFetch\s*\(/,
		) ??
		'createAuthenticatedFetch'
	const oauthClientCredentials =
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']oauthClientCredentials["']/,
		) ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyCreatePackageBoundOauthClientCredentials\s*\(/,
		) ??
		'oauthClientCredentials'
	const packageRuntimeDefault =
		readLastAssignmentBindingName(
			preambleSource,
			/new\s+Proxy\s*\(\s*runtime_default\s*,/,
		) ?? null
	// Prefer the package-runtime facade freeze (last match) over the shared
	// runtime `KodyRuntime = Object.freeze({ defaultValue: runtime_default })`.
	const kodyRuntime =
		readLastAssignmentBindingName(
			preambleSource,
			/Object\.freeze\s*\(\s*\{\s*defaultValue:\s*(?:__kodyPackageRuntimeDefault|[A-Za-z_$][\w$]*)/,
		) ?? null
	return {
		packageStorage,
		packageSecrets,
		createAuthenticatedFetch,
		oauthClientCredentials,
		packageRuntimeDefault,
		kodyRuntime,
	}
}

function authorSourceDeclaresBinding(source: string, name: string) {
	return new RegExp(
		`(?:(?:var|let|const|function|class)\\s+|export\\s+(?:async\\s+)?function\\s+)${name}\\b`,
	).test(source)
}

function emitCanonicalAlias(
	canonical: string,
	actual: string,
	retainedAuthorSource: string,
) {
	if (actual === canonical) return ''
	// Author code may already bind the canonical name (e.g. a local helper
	// named `packageStorage`). Emitting `var packageStorage = packageStorage2`
	// would then SyntaxError or shadow incorrectly — skip the alias.
	if (authorSourceDeclaresBinding(retainedAuthorSource, canonical)) {
		return ''
	}
	return `var ${canonical} = ${actual};`
}

function createInlinedRuntimeReplacementPreamble(input: {
	relativeShimSpecifier: string
	packageId: string | null
	bindingNames: ReturnType<typeof readInlinedBindingNames>
	retainedAuthorSource: string
}) {
	const shim = JSON.stringify(input.relativeShimSpecifier)
	const {
		packageStorage,
		packageSecrets,
		createAuthenticatedFetch,
		oauthClientCredentials,
		packageRuntimeDefault,
		kodyRuntime,
	} = input.bindingNames

	const facadeDefaultObject = `{
	createAuthenticatedFetch: ${createAuthenticatedFetch},
	oauthClientCredentials: ${oauthClientCredentials},
	packageStorage: ${packageStorage},
	packageSecrets: ${packageSecrets},
	secretHeaders,
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
}`
	const facadeLines: Array<string> = []
	if (packageRuntimeDefault) {
		facadeLines.push(`var ${packageRuntimeDefault} = ${facadeDefaultObject};`)
		if (packageRuntimeDefault !== '__kodyPackageRuntimeDefault') {
			facadeLines.push(
				`var __kodyPackageRuntimeDefault = ${packageRuntimeDefault};`,
			)
		}
	}
	if (kodyRuntime) {
		const defaultValueExpr = packageRuntimeDefault ?? facadeDefaultObject
		facadeLines.push(
			`var ${kodyRuntime} = Object.freeze({ defaultValue: ${defaultValueExpr} });`,
		)
		if (
			kodyRuntime !== 'KodyRuntime' &&
			!authorSourceDeclaresBinding(input.retainedAuthorSource, 'KodyRuntime')
		) {
			facadeLines.push(`var KodyRuntime = ${kodyRuntime};`)
		}
	}
	const facadeBlock = facadeLines.filter(Boolean).join('\n')

	if (input.packageId) {
		const packageIdLiteral = JSON.stringify(input.packageId)
		const aliases = [
			emitCanonicalAlias(
				'packageStorage',
				packageStorage,
				input.retainedAuthorSource,
			),
			emitCanonicalAlias(
				'packageSecrets',
				packageSecrets,
				input.retainedAuthorSource,
			),
			emitCanonicalAlias(
				'createAuthenticatedFetch',
				createAuthenticatedFetch,
				input.retainedAuthorSource,
			),
			emitCanonicalAlias(
				'oauthClientCredentials',
				oauthClientCredentials,
				input.retainedAuthorSource,
			),
		]
			.filter(Boolean)
			.join('\n')
		return `
import {
	kody,
	secretHeaders,
	packageContext,
	email,
	workflows,
	packages,
	events,
	__kodyCreatePackageBoundAuthenticatedFetch,
	__kodyCreatePackageBoundStorage,
	__kodyCreatePackageBoundSecrets,
	__kodyCreatePackageBoundOauthClientCredentials,
} from ${shim};

var ${createAuthenticatedFetch} = __kodyCreatePackageBoundAuthenticatedFetch(${packageIdLiteral});
var ${packageStorage} = __kodyCreatePackageBoundStorage(${packageIdLiteral});
var ${packageSecrets} = __kodyCreatePackageBoundSecrets(${packageIdLiteral});
var ${oauthClientCredentials} = __kodyCreatePackageBoundOauthClientCredentials(${packageIdLiteral});
${aliases}
${facadeBlock}
`.trim()
	}

	// Unstamped inlined runtime (rare): import shim helpers under stable local
	// aliases, then expose whatever esbuild names the author body still uses.
	return `
import {
	kody,
	createAuthenticatedFetch as __kodyShimCreateAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials as __kodyShimOauthClientCredentials,
	packageContext,
	packageStorage as __kodyShimPackageStorage,
	packageSecrets as __kodyShimPackageSecrets,
	email,
	workflows,
	packages,
	events,
} from ${shim};

var ${createAuthenticatedFetch} = __kodyShimCreateAuthenticatedFetch;
var ${oauthClientCredentials} = __kodyShimOauthClientCredentials;
var ${packageStorage} = __kodyShimPackageStorage;
var ${packageSecrets} = __kodyShimPackageSecrets;
${emitCanonicalAlias('createAuthenticatedFetch', createAuthenticatedFetch, input.retainedAuthorSource)}
${emitCanonicalAlias('oauthClientCredentials', oauthClientCredentials, input.retainedAuthorSource)}
${emitCanonicalAlias('packageStorage', packageStorage, input.retainedAuthorSource)}
${emitCanonicalAlias('packageSecrets', packageSecrets, input.retainedAuthorSource)}
${facadeBlock}
`.trim()
}
