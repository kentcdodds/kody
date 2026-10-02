import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
} from './module-graph-path-basics.ts'

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
	const authorBindings = collectTopLevelBindingNames(retained)
	if (authorBindings == null) {
		// Retained author source is not parseable as a module; refuse rather
		// than emit aliases that might collide with undetectable bindings.
		return { source: input.source, rewritten: false, packageId: null }
	}
	const packageBoundBindings = readPackageBoundBindings(preambleSource)
	const packageId =
		packageBoundBindings.findLast(
			(binding) => binding.kind === 'packageStorage',
		)?.packageId ??
		packageBoundBindings.at(-1)?.packageId ??
		null
	const bindingNames = readInlinedBindingNames(preambleSource)
	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const preamble = createInlinedRuntimeReplacementPreamble({
		relativeShimSpecifier: relativeShim,
		packageId,
		packageBoundBindings,
		bindingNames,
		authorBindings,
	})

	// Walk sections in order: keep author modules where they were, emit the
	// shim once at the first removed runtime/package-runtime section.
	const parts: Array<string> = []
	let emittedPreamble = false
	for (const section of sections) {
		if (isRemovableRuntimeSection(section.banner)) {
			if (!emittedPreamble) {
				parts.push(preamble)
				emittedPreamble = true
			}
			continue
		}
		parts.push(section.source)
	}
	if (!emittedPreamble) parts.unshift(preamble)
	return {
		source: parts.join('\n\n'),
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

type PackageBoundBindingKind =
	| 'packageStorage'
	| 'packageSecrets'
	| 'createAuthenticatedFetch'
	| 'oauthClientCredentials'

type PackageBoundBinding = {
	kind: PackageBoundBindingKind
	name: string
	packageId: string
}

const packageBoundFactoryPatterns: ReadonlyArray<{
	kind: PackageBoundBindingKind
	rhs: RegExp
}> = [
	{ kind: 'packageStorage', rhs: /__kodyCreatePackageBoundStorage\s*\(/ },
	{ kind: 'packageSecrets', rhs: /__kodyCreatePackageBoundSecrets\s*\(/ },
	{
		kind: 'createAuthenticatedFetch',
		rhs: /__kodyCreatePackageBoundAuthenticatedFetch\s*\(/,
	},
	{
		kind: 'oauthClientCredentials',
		rhs: /__kodyCreatePackageBoundOauthClientCredentials\s*\(/,
	},
]

/**
 * Every package-stamped factory assignment in the removed preamble, in source
 * order. Multi-facade graphs bind dependency storage/secrets before the root;
 * each binding keeps the package ID from its own facade.
 */
export function readPackageBoundBindings(
	preambleSource: string,
): Array<PackageBoundBinding> {
	const bindings: Array<PackageBoundBinding & { index: number }> = []
	for (const { kind, rhs } of packageBoundFactoryPatterns) {
		const pattern = new RegExp(
			`(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${rhs.source}\\s*["']([^"']+)["']`,
			'g',
		)
		for (const match of preambleSource.matchAll(pattern)) {
			const name = match[1]
			const packageId = match[2]
			if (!name || !packageId) continue
			bindings.push({ kind, name, packageId, index: match.index ?? 0 })
		}
	}
	bindings.sort((left, right) => left.index - right.index)
	return bindings.map(({ kind, name, packageId }) => ({
		kind,
		name,
		packageId,
	}))
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

function lastBindingNameForKind(
	bindings: ReadonlyArray<PackageBoundBinding>,
	kind: PackageBoundBindingKind,
) {
	return bindings.findLast((binding) => binding.kind === kind)?.name ?? null
}

/**
 * Esbuild renames colliding inlined bindings (`packageStorage` →
 * `packageStorage2`). Author code after the cut references those renamed
 * identifiers, so the replacement preamble must reuse the same names.
 *
 * For multi-facade graphs, package-bound names come from
 * {@link readPackageBoundBindings} (last-of-kind for facades/aliases). This
 * helper still resolves optional-export CAF/oauth names and facade identifiers.
 */
export function readInlinedBindingNames(preambleSource: string) {
	const packageBoundBindings = readPackageBoundBindings(preambleSource)
	const packageStorage =
		lastBindingNameForKind(packageBoundBindings, 'packageStorage') ??
		'packageStorage'
	const packageSecrets =
		lastBindingNameForKind(packageBoundBindings, 'packageSecrets') ??
		'packageSecrets'
	const createAuthenticatedFetch =
		lastBindingNameForKind(packageBoundBindings, 'createAuthenticatedFetch') ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']createAuthenticatedFetch["']/,
		) ??
		'createAuthenticatedFetch'
	const oauthClientCredentials =
		lastBindingNameForKind(packageBoundBindings, 'oauthClientCredentials') ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']oauthClientCredentials["']/,
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

function getBindingIdentifierName(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null
	const candidate = node as { name?: unknown; value?: unknown }
	if (typeof candidate.name === 'string') return candidate.name
	if (typeof candidate.value === 'string') return candidate.value
	return null
}

function collectPatternBoundNames(node: unknown, names: Set<string>) {
	if (!node || typeof node !== 'object') return
	const typedNode = node as ModuleAstNode
	switch (typedNode.type) {
		case 'Identifier': {
			const name = getBindingIdentifierName(typedNode)
			if (name) names.add(name)
			return
		}
		case 'ObjectPattern': {
			const properties = (typedNode as { properties?: unknown }).properties
			if (!Array.isArray(properties)) return
			for (const property of properties) {
				if (!property || typeof property !== 'object') continue
				const typedProperty = property as ModuleAstNode
				if (typedProperty.type === 'RestElement') {
					collectPatternBoundNames(
						(typedProperty as { argument?: unknown }).argument,
						names,
					)
					continue
				}
				collectPatternBoundNames(
					(typedProperty as { value?: unknown }).value,
					names,
				)
			}
			return
		}
		case 'ArrayPattern': {
			const elements = (typedNode as { elements?: unknown }).elements
			if (!Array.isArray(elements)) return
			for (const element of elements) {
				collectPatternBoundNames(element, names)
			}
			return
		}
		case 'AssignmentPattern': {
			collectPatternBoundNames((typedNode as { left?: unknown }).left, names)
			return
		}
		case 'RestElement': {
			collectPatternBoundNames(
				(typedNode as { argument?: unknown }).argument,
				names,
			)
			return
		}
		default:
			return
	}
}

/**
 * Top-level value bindings in retained author source. Returns `null` when the
 * source cannot be parsed (caller should refuse the rewrite).
 */
function collectTopLevelBindingNames(source: string): Set<string> | null {
	if (!source.trim()) return new Set()
	try {
		const parsed = parseModuleSource(source) as unknown as ModuleAstNode
		const program = parsed.program as
			| { body?: Array<ModuleAstNode> }
			| undefined
		const body =
			program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
		if (!Array.isArray(body)) return new Set()
		const names = new Set<string>()
		for (const statement of body) {
			if (!statement || typeof statement !== 'object') continue
			const node = statement as ModuleAstNode & {
				declaration?: ModuleAstNode | null
				specifiers?: Array<ModuleAstNode>
				id?: unknown
				declarations?: Array<{ id?: unknown }>
			}
			if (node.type === 'ImportDeclaration') {
				for (const specifier of node.specifiers ?? []) {
					const local = getBindingIdentifierName(
						(specifier as { local?: unknown }).local,
					)
					if (local) names.add(local)
				}
				continue
			}
			if (
				node.type === 'FunctionDeclaration' ||
				node.type === 'ClassDeclaration'
			) {
				const name = getBindingIdentifierName(node.id)
				if (name) names.add(name)
				continue
			}
			if (node.type === 'VariableDeclaration') {
				for (const declarator of node.declarations ?? []) {
					collectPatternBoundNames(declarator.id, names)
				}
				continue
			}
			if (node.type === 'ExportNamedDeclaration' && node.declaration) {
				const declaration = node.declaration
				if (
					declaration.type === 'FunctionDeclaration' ||
					declaration.type === 'ClassDeclaration'
				) {
					const name = getBindingIdentifierName(
						(declaration as { id?: unknown }).id,
					)
					if (name) names.add(name)
					continue
				}
				if (declaration.type === 'VariableDeclaration') {
					for (const declarator of (
						declaration as { declarations?: Array<{ id?: unknown }> }
					).declarations ?? []) {
						collectPatternBoundNames(declarator.id, names)
					}
				}
				continue
			}
			if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
				const declaration = node.declaration
				if (
					declaration.type === 'FunctionDeclaration' ||
					declaration.type === 'ClassDeclaration'
				) {
					const name = getBindingIdentifierName(
						(declaration as { id?: unknown }).id,
					)
					if (name) names.add(name)
				}
			}
		}
		return names
	} catch {
		return null
	}
}

function emitCanonicalAlias(
	canonical: string,
	actual: string,
	authorBindings: ReadonlySet<string>,
) {
	if (actual === canonical) return ''
	// Author code may already bind the canonical name (e.g. a local helper
	// named `packageStorage`). Emitting `var packageStorage = packageStorage2`
	// would then SyntaxError or shadow incorrectly — skip the alias.
	if (authorBindings.has(canonical)) return ''
	return `var ${canonical} = ${actual};`
}

function createInlinedRuntimeReplacementPreamble(input: {
	relativeShimSpecifier: string
	packageId: string | null
	packageBoundBindings: ReadonlyArray<PackageBoundBinding>
	bindingNames: ReturnType<typeof readInlinedBindingNames>
	authorBindings: ReadonlySet<string>
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
			!input.authorBindings.has('KodyRuntime')
		) {
			facadeLines.push(`var KodyRuntime = ${kodyRuntime};`)
		}
	}
	const facadeBlock = facadeLines.filter(Boolean).join('\n')

	if (input.packageId) {
		const packageIdLiteral = JSON.stringify(input.packageId)
		const packageBoundLines: Array<string> = []
		const emittedBindingNames = new Set<string>()
		for (const binding of input.packageBoundBindings) {
			if (emittedBindingNames.has(binding.name)) continue
			emittedBindingNames.add(binding.name)
			const idLiteral = JSON.stringify(binding.packageId)
			switch (binding.kind) {
				case 'packageStorage':
					packageBoundLines.push(
						`var ${binding.name} = __kodyCreatePackageBoundStorage(${idLiteral});`,
					)
					break
				case 'packageSecrets':
					packageBoundLines.push(
						`var ${binding.name} = __kodyCreatePackageBoundSecrets(${idLiteral});`,
					)
					break
				case 'createAuthenticatedFetch':
					packageBoundLines.push(
						`var ${binding.name} = __kodyCreatePackageBoundAuthenticatedFetch(${idLiteral});`,
					)
					break
				case 'oauthClientCredentials':
					packageBoundLines.push(
						`var ${binding.name} = __kodyCreatePackageBoundOauthClientCredentials(${idLiteral});`,
					)
					break
				default: {
					const _exhaustive: never = binding.kind
					throw new Error(`Unexpected package-bound kind: ${_exhaustive}`)
				}
			}
		}
		// Optional-export CAF/oauth (shared runtime) and any missing host
		// bindings stamp to the root package id so author entry code still
		// resolves them under --local.
		if (!emittedBindingNames.has(createAuthenticatedFetch)) {
			packageBoundLines.push(
				`var ${createAuthenticatedFetch} = __kodyCreatePackageBoundAuthenticatedFetch(${packageIdLiteral});`,
			)
			emittedBindingNames.add(createAuthenticatedFetch)
		}
		if (!emittedBindingNames.has(packageStorage)) {
			packageBoundLines.push(
				`var ${packageStorage} = __kodyCreatePackageBoundStorage(${packageIdLiteral});`,
			)
			emittedBindingNames.add(packageStorage)
		}
		if (!emittedBindingNames.has(packageSecrets)) {
			packageBoundLines.push(
				`var ${packageSecrets} = __kodyCreatePackageBoundSecrets(${packageIdLiteral});`,
			)
			emittedBindingNames.add(packageSecrets)
		}
		if (!emittedBindingNames.has(oauthClientCredentials)) {
			packageBoundLines.push(
				`var ${oauthClientCredentials} = __kodyCreatePackageBoundOauthClientCredentials(${packageIdLiteral});`,
			)
			emittedBindingNames.add(oauthClientCredentials)
		}
		const aliases = [
			emitCanonicalAlias(
				'packageStorage',
				packageStorage,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'packageSecrets',
				packageSecrets,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'createAuthenticatedFetch',
				createAuthenticatedFetch,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'oauthClientCredentials',
				oauthClientCredentials,
				input.authorBindings,
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

${packageBoundLines.join('\n')}
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
${emitCanonicalAlias('createAuthenticatedFetch', createAuthenticatedFetch, input.authorBindings)}
${emitCanonicalAlias('oauthClientCredentials', oauthClientCredentials, input.authorBindings)}
${emitCanonicalAlias('packageStorage', packageStorage, input.authorBindings)}
${emitCanonicalAlias('packageSecrets', packageSecrets, input.authorBindings)}
${facadeBlock}
`.trim()
}
