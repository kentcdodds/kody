/**
 * Build-time credential stamp (issue #3836): sealed allowlist of literal
 * credential keys a package may resolve, plus dependency stamp pins. Phase 1
 * sealed publish; phase 2 fleet-seals existing packages (mcp literals +
 * inferred descriptions). Runtime fail-closed enforcement is phase 3.
 */
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	type AstNode,
	constantsWithoutShadows,
	createModuleConstantsReader,
	getNodeName,
	listScannableModulePaths,
	parseModule,
	resolveStringExpression,
	scannableModuleFilePattern,
	unwrapExpression,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	scanPackageCredentials,
	type PackageCredentialScan,
} from '#worker/credentials/credential-inventory-scan.ts'
import {
	getPackageAppClientEntryPath,
	getPackageAppEntryPath,
	listPackageSubscriptions,
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	packageCredentialKindValues,
	packageCredentialSlotNamePattern,
	type AuthoredPackageJson,
	type PackageCredentialKind,
	type PackageCredentialSlot,
} from '#worker/package-registry/types.ts'
import { collectDynamicImportExpressionNodes } from '#worker/package-runtime/import-specifiers.ts'
import { collectReachableSourceFilePaths } from '#worker/package-runtime/module-graph-workspace.ts'
import { collectPublishedPackageArtifactTargets } from '#worker/package-runtime/package-artifact-targets.ts'
import {
	detectLegacyCredentialPatternsCodemod,
	legacyCredentialPatternFromMessage,
	type LegacyCredentialPattern,
	scanModuleCredentialReferences,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'

export const credentialStampVersion = 1 as const
export const credentialStampFileName = 'credential-stamp.json'

export type CredentialDepStamp = {
	packageId: string
	publishedCommit: string
	stampHash: string
}

export type CredentialStamp = {
	version: typeof credentialStampVersion
	keys: Array<string>
	depStamps: Array<CredentialDepStamp>
	stampHash: string
}

export type CredentialStampGateFailure = {
	code:
		| 'non_literal'
		| 'unstampable_pattern'
		| 'server_eval'
		| 'missing_description'
		| 'invalid_key'
		| 'credential_named'
	path?: string
	/** Agent-facing fix instructions; never include credential values. */
	message: string
}

export type CredentialStampScan = {
	/** Sorted unique literal keys this package's own source stamps. */
	keys: Array<string>
	failures: Array<CredentialStampGateFailure>
	/** Keys present in `kody.credentials` but not in the stamp (stale). */
	staleManifestKeys: Array<string>
	/** Literal `kody.mcp` server names sealed as `kind: "mcp"` slots. */
	mcpKeys: Array<string>
	/** Literal `secretJwtSign` private-key secret names. */
	jwtSignKeys: Array<string>
	/** Literal integration / createAuthenticatedFetch account names. */
	oauthKeys: Array<string>
	scan: PackageCredentialScan
}

/**
 * A slot the phase-2 seal codemod / backfill can write without overwriting an
 * existing description.
 */
export type CredentialStampSealSlot = {
	key: string
	description: string
	kind?: PackageCredentialKind
}

export type CredentialStampSealPlan = {
	keys: Array<string>
	/** Slots to insert or fill (existing descriptions are never overwritten). */
	updates: Array<CredentialStampSealSlot>
	/** Stamp keys that still need a human description. */
	uninferableKeys: Array<string>
	/** Gate failures that block sealing (excludes missing_description for keys in updates). */
	blockingFailures: Array<CredentialStampGateFailure>
	staleManifestKeys: Array<string>
	/** True when keys are stamped, every key has a description, and nothing blocks. */
	sealReady: boolean
}

const packageManifestPath = 'package.json'

/**
 * 0010 labels that cannot be sealed into a stamp allowlist. `kody.mcp` stays
 * off this list: phase 2 stamps literal server names and fails dynamic access
 * via {@link scanLiteralMcpServerKeys}. Non-literal names, `|scope=`,
 * secretMounts, packageSecrets.get, and plain http still fail closed.
 */
const unstampableLegacyPatterns = new Set<LegacyCredentialPattern>([
	'computed secret',
	'computed integration',
	'|scope=',
	'secretMounts',
	'packageSecrets.get',
	'plain http',
])

const credentialFunctionNames = new Set(['credential', 'credentials'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

const packageCredentialKinds: ReadonlySet<string> = new Set(
	packageCredentialKindValues,
)

type ManifestCredentialSlot = {
	description: string | null
	kind?: PackageCredentialKind
	provider?: string
	multiple?: boolean
}

function readManifestCredentialSlots(
	manifestSource: string | undefined,
): Record<string, ManifestCredentialSlot> {
	if (manifestSource == null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return {}
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return {}
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return {}
	const slots: Record<string, ManifestCredentialSlot> = {}
	for (const [name, slot] of Object.entries(credentials)) {
		if (!isPlainObject(slot)) continue
		const description =
			typeof slot.description === 'string' && slot.description.trim().length > 0
				? slot.description.trim()
				: null
		const declared: ManifestCredentialSlot = { description }
		if (
			typeof slot.kind === 'string' &&
			packageCredentialKinds.has(slot.kind)
		) {
			declared.kind = slot.kind as PackageCredentialKind
		}
		if (typeof slot.provider === 'string' && slot.provider.trim().length > 0) {
			declared.provider = slot.provider
		}
		if (typeof slot.multiple === 'boolean') declared.multiple = slot.multiple
		slots[name] = declared
	}
	return slots
}

function toInventorySlots(
	slots: Record<string, ManifestCredentialSlot>,
): Record<string, PackageCredentialSlot> | undefined {
	const out: Record<string, PackageCredentialSlot> = {}
	for (const [name, slot] of Object.entries(slots)) {
		if (slot.description == null) continue
		out[name] = {
			description: slot.description,
			...(slot.kind ? { kind: slot.kind } : {}),
			...(slot.provider ? { provider: slot.provider } : {}),
			...(slot.multiple != null ? { multiple: slot.multiple } : {}),
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function slotDescription(
	slots: Record<string, ManifestCredentialSlot>,
	key: string,
): string | null {
	return slots[key]?.description ?? null
}

type CredentialBindings = {
	functions: Set<string>
	runtimeObjects: Set<string>
}

function collectCredentialBindings(body: Array<AstNode>): CredentialBindings {
	const functions = new Set<string>()
	const runtimeObjects = new Set<string>(['kody'])
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			const local = getNodeName(specifier.local)
			if (!local) continue
			if (
				specifier.type === 'ImportDefaultSpecifier' ||
				specifier.type === 'ImportNamespaceSpecifier'
			) {
				runtimeObjects.add(local)
				continue
			}
			const imported = getNodeName(specifier.imported)
			if (specifier.type === 'ImportSpecifier' && imported === 'kody') {
				runtimeObjects.add(local)
			}
			if (imported && credentialFunctionNames.has(imported)) {
				functions.add(local)
			}
		}
	}
	return { functions, runtimeObjects }
}

/** Property name of a member expression, including `obj['literal']`. */
function memberPropertyName(node: AstNode | undefined): string | null {
	if (
		node?.type !== 'MemberExpression' &&
		node?.type !== 'OptionalMemberExpression'
	) {
		return null
	}
	if (node.computed === true) {
		const property = node.property
		if (property?.type === 'StringLiteral' || property?.type === 'Literal') {
			return getNodeName(property)
		}
		return null
	}
	return getNodeName(node.property)
}

/**
 * `credential` / `credentials` as an imported binding or as
 * `kody.credential` / `kody['credential']` on a tracked runtime object.
 */
function isCredentialFunctionValue(
	node: AstNode | undefined,
	bindings: CredentialBindings,
): boolean {
	if (node?.type === 'Identifier') {
		return bindings.functions.has(getNodeName(node) ?? '')
	}
	if (
		node?.type !== 'MemberExpression' &&
		node?.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	if (node.object?.type !== 'Identifier') return false
	if (!bindings.runtimeObjects.has(getNodeName(node.object) ?? '')) {
		return false
	}
	const property = memberPropertyName(node)
	return property != null && credentialFunctionNames.has(property)
}

function isCredentialCallee(
	callee: AstNode | undefined,
	bindings: CredentialBindings,
) {
	return isCredentialFunctionValue(callee, bindings)
}

function isCredentialNamedMember(
	node: AstNode | undefined,
	bindings: CredentialBindings,
): boolean {
	if (
		node?.type !== 'MemberExpression' &&
		node?.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	if (memberPropertyName(node) !== 'named') return false
	return isCredentialFunctionValue(node.object, bindings)
}

function isNonReferenceName(node: AstNode, parent: AstNode) {
	if (parent.computed === true) return false
	if (
		parent.type === 'MemberExpression' ||
		parent.type === 'OptionalMemberExpression'
	) {
		return parent.property === node
	}
	if (
		parent.type === 'Property' ||
		parent.type === 'ObjectProperty' ||
		parent.type === 'MethodDefinition' ||
		parent.type === 'PropertyDefinition'
	) {
		return (
			parent.key === node &&
			(parent as { shorthand?: boolean }).shorthand !== true
		)
	}
	return false
}

type KeyScan = {
	key: (key: string) => void
	computed: () => void
	named: () => void
	indirect: () => void
}

function scanParsedCredentialKeys(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	scan: KeyScan,
) {
	const bindings = collectCredentialBindings(parsed.program?.body ?? [])
	walkAst(parsed, (node, ancestors) => {
		if (
			node.type === 'CallExpression' ||
			node.type === 'OptionalCallExpression'
		) {
			if (isCredentialNamedMember(node.callee, bindings)) {
				scan.named()
				return
			}
			if (isCredentialCallee(node.callee, bindings)) {
				const key = resolveStringExpression(
					node.arguments?.[0],
					constantsWithoutShadows(constants, ancestors),
				)
				if (key == null) scan.computed()
				else scan.key(key)
				return
			}
		}
		if (
			(node.type === 'MemberExpression' ||
				node.type === 'OptionalMemberExpression') &&
			isCredentialNamedMember(node, bindings)
		) {
			const parent = ancestors.at(-1)
			const called =
				parent &&
				(parent.type === 'CallExpression' ||
					parent.type === 'OptionalCallExpression') &&
				parent.callee === node
			if (!called) scan.named()
			return
		}
		// `kody.credential.bind(kody)`, `const get = kody.credential`, etc. —
		// any non-call use of the credential function value escapes the stamp.
		if (
			(node.type === 'MemberExpression' ||
				node.type === 'OptionalMemberExpression') &&
			isCredentialFunctionValue(node, bindings)
		) {
			const parent = ancestors.at(-1)
			const called =
				parent &&
				(parent.type === 'CallExpression' ||
					parent.type === 'OptionalCallExpression') &&
				parent.callee === node
			const namedAccess =
				parent &&
				(parent.type === 'MemberExpression' ||
					parent.type === 'OptionalMemberExpression') &&
				parent.object === node &&
				memberPropertyName(parent) === 'named'
			if (!called && !namedAccess) scan.indirect()
			return
		}
		if (node.type !== 'Identifier') return
		if (!bindings.functions.has(getNodeName(node) ?? '')) return
		const parent = ancestors.at(-1)
		if (!parent || parent.type.startsWith('Import')) return
		if (isNonReferenceName(node, parent)) return
		const isCallee =
			(parent.type === 'CallExpression' ||
				parent.type === 'OptionalCallExpression') &&
			parent.callee === node
		const isNamedAccess =
			(parent.type === 'MemberExpression' ||
				parent.type === 'OptionalMemberExpression') &&
			parent.object === node &&
			memberPropertyName(parent) === 'named'
		if (isNamedAccess) {
			scan.named()
			return
		}
		if (!isCallee) scan.indirect()
	})
}

const textCredentialCallPattern =
	/\bcredentials?\s*\(\s*(?:(['"`])([^'"`$\\]*)\1)?/g

function scanUnparsedCredentialKeys(source: string, scan: KeyScan) {
	if (!/\bkody:runtime\b|\bkody\s*(?:\?\.|\.)\s*credentials?\b/.test(source)) {
		return
	}
	if (/\bcredentials?\s*(?:\?\.|\.)\s*named\b/.test(source)) {
		scan.named()
	}
	for (const match of source.matchAll(textCredentialCallPattern)) {
		if (match[2] == null) scan.computed()
		else scan.key(match[2])
	}
}

function nonLiteralFixMessage(kind: string) {
	return `${kind} Publish cannot stamp a credential whose name is only known at run time. Declare every credential this package can use as a kody.credentials slot with a description, and branch among them with literal credential("KEY") (or literal createAuthenticatedFetch("account") / secretJwtSign names). credential.named() is only for ad hoc runs and unshared personal-org packages, which are not stamped.`
}

/**
 * Server-runtime module paths for the eval rule: every published artifact
 * entry except `app-client`, plus modules reachable from those entries.
 * Modules shared with the UI graph follow the server rule.
 */
export function collectServerRuntimeModulePaths(
	files: Record<string, string>,
): Set<string> {
	const manifestSource = files[packageManifestPath]
	if (manifestSource == null) return new Set()
	let manifest: AuthoredPackageJson
	try {
		manifest = parseAuthoredPackageJson({
			content: manifestSource,
			mode: 'published',
		})
	} catch {
		return new Set()
	}
	const rootPackage = {
		manifest,
		prefix: '',
	}
	const serverEntries = new Set<string>()
	for (const target of collectPublishedPackageArtifactTargets(manifest)) {
		if (target.bundleKind === 'app-client') continue
		serverEntries.add(normalizePackageWorkspacePath(target.entryPoint))
	}
	const appEntry = getPackageAppEntryPath(manifest)
	if (appEntry) serverEntries.add(appEntry)
	for (const subscription of listPackageSubscriptions(manifest)) {
		serverEntries.add(normalizePackageWorkspacePath(subscription.handler))
	}
	// `main` / `module` are not on AuthoredPackageJson; read them from the
	// raw manifest. `browser` and kody.app.client stay UI-only roots.
	let rawManifest: unknown
	try {
		rawManifest = JSON.parse(manifestSource)
	} catch {
		rawManifest = null
	}
	if (isPlainObject(rawManifest)) {
		for (const field of ['main', 'module'] as const) {
			const value = rawManifest[field]
			if (typeof value === 'string' && value.trim()) {
				serverEntries.add(normalizePackageWorkspacePath(value))
			}
		}
	}
	void getPackageAppClientEntryPath(manifest)

	const serverReachable = new Set<string>()
	for (const entry of serverEntries) {
		for (const path of collectReachableSourceFilePaths({
			files,
			entryPoint: entry,
			rootPackage,
		})) {
			if (scannableModuleFilePattern.test(path)) {
				serverReachable.add(path)
			}
		}
	}
	return serverReachable
}

const globalObjectNames = new Set(['globalThis', 'window', 'global', 'self'])

function templateLiteralStaticText(node: AstNode | undefined): string | null {
	if (node?.type !== 'TemplateLiteral') return null
	if ((node.expressions?.length ?? 0) > 0) return null
	const quasi = node.quasis?.[0]
	if (!quasi) return null
	const value = quasi.value as
		| { cooked?: string | null; raw?: string }
		| undefined
	if (typeof value?.cooked === 'string') return value.cooked
	if (typeof value?.raw === 'string') return value.raw
	return getNodeName(quasi)
}

/**
 * True when `node` is `eval` / `Function`, or a member access that ends in
 * those names (`globalThis.eval`, `window['Function']`, `new globalThis.Function`).
 * Call-form `Function("…")()` is covered the same way as `new Function`.
 * Parenthesized / TS-wrapped callees are unwrapped first.
 */
function isEvalOrFunctionTarget(node: AstNode | null | undefined): boolean {
	const target = unwrapExpression(node ?? undefined)
	if (!target) return false
	if (target.type === 'Identifier') {
		const name = getNodeName(target)
		return name === 'eval' || name === 'Function'
	}
	if (
		target.type === 'MemberExpression' ||
		target.type === 'OptionalMemberExpression'
	) {
		if (target.computed === true) {
			const prop = unwrapExpression(target.property)
			const literal =
				prop?.type === 'Literal' || prop?.type === 'StringLiteral'
					? typeof prop.value === 'string'
						? prop.value
						: null
					: templateLiteralStaticText(prop)
			if (literal != null) return literal === 'eval' || literal === 'Function'
			// Fail closed on globalThis[expr] / window[name] — property is not a
			// static literal, so publish cannot prove it is not eval/Function.
			const object = unwrapExpression(target.object)
			return globalObjectNames.has(getNodeName(object) ?? '')
		}
		const name = getNodeName(target.property)
		return name === 'eval' || name === 'Function'
	}
	return false
}

const serverEvalTextFallbackPattern =
	/\b(?:globalThis|window|global|self)\s*(?:\?\.)?\s*(?:\.\s*(?:eval|Function)\b|\[\s*['"](?:eval|Function)['"]\s*\])|\beval\s*\(|\b(?:new\s+)?Function\s*\(|\bimport\s*\(\s*[^'"`]/

function scanServerEvalFailures(
	files: Record<string, string>,
	serverPaths: ReadonlySet<string>,
): Array<CredentialStampGateFailure> {
	const failures: Array<CredentialStampGateFailure> = []
	for (const path of [...serverPaths].sort()) {
		const source = files[path]
		if (source == null) continue
		const parsed = parseModule(source)
		if (!parsed) {
			if (serverEvalTextFallbackPattern.test(source)) {
				failures.push({
					code: 'server_eval',
					path,
					message: `${path}: server-runtime code looks like it uses eval, new Function, or a non-literal import(). Remove those from execute/export/handler/trigger and Worker app graphs (UI/client bundles may keep them). Shared modules follow the server rule.`,
				})
			}
			continue
		}
		let foundEval = false
		walkAst(parsed, (node) => {
			if (foundEval) return
			if (
				(node.type === 'CallExpression' ||
					node.type === 'OptionalCallExpression' ||
					node.type === 'NewExpression') &&
				isEvalOrFunctionTarget(node.callee)
			) {
				foundEval = true
			}
		})
		const dynamicImports = collectDynamicImportExpressionNodes(source)
		const hasNonLiteralImport = dynamicImports.some(
			(node) => node.literalSpecifier == null,
		)
		if (foundEval || hasNonLiteralImport) {
			failures.push({
				code: 'server_eval',
				path,
				message: `${path}: server-runtime code must not use eval, new Function (including globalThis/window aliases and Function("…")()), or import() with a non-literal specifier. Move that code into a kody.app.client (UI) entry, or rewrite it to static imports. Shared modules imported by server entries follow the server rule.`,
			})
		}
	}
	return failures
}

/**
 * Collect literal `kody.mcp.SERVER` / `kody.mcp["SERVER"]` names and fail on
 * dynamic access (`kody.mcp[variable]`, `const { mcp } = kody` then computed).
 */
export function scanLiteralMcpServerKeys(files: Record<string, string>): {
	keys: Array<string>
	failures: Array<CredentialStampGateFailure>
} {
	const keys = new Set<string>()
	const failures: Array<CredentialStampGateFailure> = []
	const modulePaths = listScannableModulePaths(files)
	for (const path of modulePaths) {
		const source = files[path]!
		const parsed = parseModule(source)
		if (!parsed) {
			if (
				/\bkody\s*(?:\?\.|\.)\s*mcp\b|\bkody\s*\[\s*['"`]mcp['"`]/.test(source)
			) {
				failures.push({
					code: 'non_literal',
					path,
					message: `${path}: kody.mcp access could not be parsed. Call kody.mcp.SERVER (or kody.mcp["SERVER"]) with a literal server name, and declare a kind "mcp" slot for each server.`,
				})
			}
			continue
		}
		const body = parsed.program?.body ?? []
		const kodyAliases = new Set<string>(['kody'])
		const mcpAliases = new Set<string>()
		for (const node of body) {
			if (node.type !== 'ImportDeclaration') continue
			if (getNodeName(node.source) !== 'kody:runtime') continue
			for (const specifier of node.specifiers ?? []) {
				const local = getNodeName(specifier.local)
				if (!local) continue
				if (
					specifier.type === 'ImportDefaultSpecifier' ||
					specifier.type === 'ImportNamespaceSpecifier'
				) {
					kodyAliases.add(local)
					continue
				}
				if (
					specifier.type === 'ImportSpecifier' &&
					getNodeName(specifier.imported) === 'kody'
				) {
					kodyAliases.add(local)
				}
			}
		}
		walkAst(parsed, (node) => {
			if (node.type === 'VariableDeclarator') {
				if (
					node.id?.type === 'ObjectPattern' &&
					node.init?.type === 'Identifier' &&
					kodyAliases.has(getNodeName(node.init) ?? '')
				) {
					for (const property of node.id.properties ?? []) {
						if (property.type !== 'ObjectProperty') continue
						if (getNodeName(property.key) !== 'mcp') continue
						const value = property.value as AstNode | undefined
						const local =
							value?.type === 'Identifier'
								? getNodeName(value)
								: getNodeName(property.key)
						if (local) mcpAliases.add(local)
						else {
							failures.push({
								code: 'non_literal',
								path,
								message: `${path}: destructuring kody.mcp must bind a simple local name, then call that name with a literal server (mcp.SERVER).`,
							})
						}
					}
				}
				if (
					node.id?.type === 'ObjectPattern' &&
					node.init &&
					isKodyMcpRoot(node.init, kodyAliases, mcpAliases)
				) {
					for (const property of node.id.properties ?? []) {
						if (property.type !== 'ObjectProperty') continue
						const server = getNodeName(property.key)
						if (server && packageCredentialSlotNamePattern.test(server)) {
							keys.add(server)
						} else {
							failures.push({
								code: 'non_literal',
								path,
								message: `${path}: destructuring kody.mcp must use literal server names. Declare each server as a kind "mcp" kody.credentials slot.`,
							})
						}
					}
				}
				return
			}
			if (
				node.type !== 'MemberExpression' &&
				node.type !== 'OptionalMemberExpression'
			) {
				return
			}
			const server = mcpServerFromMember(node, kodyAliases, mcpAliases)
			if (server === undefined) return
			if (server === null) {
				failures.push({
					code: 'non_literal',
					path,
					message: `${path}: kody.mcp was accessed with a non-literal server name. Use kody.mcp.SERVER or kody.mcp["SERVER"] and declare a kind "mcp" slot for each server.`,
				})
				return
			}
			if (packageCredentialSlotNamePattern.test(server)) keys.add(server)
			else {
				failures.push({
					code: 'invalid_key',
					path,
					message: `${path}: MCP server "${server}" is not a valid kody.credentials key. Rename the attached server or declare it under a valid slot key.`,
				})
			}
		})
	}
	return { keys: [...keys].sort(), failures: dedupeFailures(failures) }
}

function isKodyMcpRoot(
	node: AstNode,
	kodyAliases: Set<string>,
	mcpAliases: Set<string>,
): boolean {
	if (node.type === 'Identifier') {
		return mcpAliases.has(getNodeName(node) ?? '')
	}
	if (
		node.type !== 'MemberExpression' &&
		node.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	if (node.object?.type !== 'Identifier') return false
	if (!kodyAliases.has(getNodeName(node.object) ?? '')) return false
	return memberPropertyName(node) === 'mcp'
}

/**
 * Literal server name from `kody.mcp.SERVER` / `mcp.SERVER`, or null when the
 * access is dynamic, or undefined when the node is not an mcp server access.
 */
function mcpServerFromMember(
	node: AstNode,
	kodyAliases: Set<string>,
	mcpAliases: Set<string>,
): string | null | undefined {
	if (
		node.type !== 'MemberExpression' &&
		node.type !== 'OptionalMemberExpression'
	) {
		return undefined
	}
	if (isKodyMcpRoot(node, kodyAliases, mcpAliases)) {
		// Bare `kody.mcp` / `mcp` root — wait for a child member when present.
		return undefined
	}
	if (!node.object || !isKodyMcpRoot(node.object, kodyAliases, mcpAliases)) {
		return undefined
	}
	if (node.computed === true) {
		const property = node.property
		if (property?.type === 'StringLiteral' || property?.type === 'Literal') {
			return getNodeName(property)
		}
		return null
	}
	return getNodeName(node.property)
}

/**
 * Infer a description for a stamp key from how the package uses it. Prefer
 * specific MCP / OAuth / signing wording; fall back to a factual use sentence
 * for other literal keys (never the empty "Describe what … is for." placeholder
 * the publish gate rejects).
 */
export function inferCredentialStampDescription(input: {
	key: string
	kind?: PackageCredentialKind
	mcp?: boolean
	jwtSign?: boolean
	oauth?: boolean
}): string {
	if (input.mcp || input.kind === 'mcp') {
		return `Calls tools on the attached MCP server "${input.key}".`
	}
	if (input.jwtSign || input.kind === 'signing') {
		return `Signs tokens with the "${input.key}" signing credential.`
	}
	if (input.oauth || input.kind === 'oauth') {
		return `OAuth access for ${input.key}.`
	}
	if (input.kind === 'login') {
		return `Login exchange for ${input.key}.`
	}
	if (input.kind === 'url') {
		return `URL credential for ${input.key}.`
	}
	return `Used by this package as credential "${input.key}".`
}

/**
 * Plan phase-2 seal updates: add missing slots / descriptions where inferable,
 * and list blocking failures / uninferable keys that need an agent or owner.
 */
export function planCredentialStampSeal(
	files: Record<string, string>,
): CredentialStampSealPlan {
	const scanned = scanCredentialStamp(files)
	const slots = readManifestCredentialSlots(files[packageManifestPath])
	const mcpKeySet = new Set(scanned.mcpKeys)
	const jwtKeySet = new Set(scanned.jwtSignKeys)
	const oauthKeySet = new Set(scanned.oauthKeys)
	const updates: Array<CredentialStampSealSlot> = []
	const uninferableKeys: Array<string> = []
	for (const key of scanned.keys) {
		const existing = slots[key]
		if (existing?.description != null) continue
		const kind: PackageCredentialKind | undefined =
			existing?.kind ??
			(mcpKeySet.has(key)
				? 'mcp'
				: jwtKeySet.has(key)
					? 'signing'
					: oauthKeySet.has(key)
						? 'oauth'
						: undefined)
		updates.push({
			key,
			description: inferCredentialStampDescription({
				key,
				kind,
				mcp: mcpKeySet.has(key),
				jwtSign: jwtKeySet.has(key),
				oauth: oauthKeySet.has(key),
			}),
			...(kind ? { kind } : {}),
		})
	}
	const blockingFailures = scanned.failures.filter(
		(failure) => failure.code !== 'missing_description',
	)
	const sealReady =
		blockingFailures.length === 0 &&
		scanned.keys.every((key) => {
			const existing = slots[key]?.description
			if (existing != null) return true
			return updates.some((update) => update.key === key)
		})
	return {
		keys: scanned.keys,
		updates,
		uninferableKeys,
		blockingFailures,
		staleManifestKeys: scanned.staleManifestKeys,
		sealReady,
	}
}

/**
 * Apply {@link planCredentialStampSeal} updates into package.json without
 * overwriting existing descriptions.
 */
export function applyCredentialStampSealPlan(
	files: Record<string, string>,
	plan: CredentialStampSealPlan,
): { files: Record<string, string>; changed: boolean } {
	if (plan.updates.length === 0) {
		return { files, changed: false }
	}
	const source = files[packageManifestPath]
	if (source == null) return { files, changed: false }
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return { files, changed: false }
	}
	if (!isPlainObject(parsed)) return { files, changed: false }
	const kody = isPlainObject(parsed.kody) ? { ...parsed.kody } : {}
	const existing = isPlainObject(kody.credentials)
		? { ...kody.credentials }
		: {}
	let changed = false
	for (const update of plan.updates) {
		const prior = isPlainObject(existing[update.key])
			? { ...(existing[update.key] as Record<string, unknown>) }
			: {}
		const priorDescription =
			typeof prior.description === 'string' &&
			prior.description.trim().length > 0
				? prior.description.trim()
				: null
		if (priorDescription != null) continue
		const next: Record<string, unknown> = {
			...prior,
			description: update.description,
		}
		if (update.kind && prior.kind == null) next.kind = update.kind
		existing[update.key] = next
		changed = true
	}
	if (!changed) return { files, changed: false }
	const indent = detectJsonIndent(source)
	const nextSource = `${JSON.stringify(
		{ ...parsed, kody: { ...kody, credentials: existing } },
		null,
		indent,
	)}\n`
	return {
		files: { ...files, [packageManifestPath]: nextSource },
		changed: true,
	}
}

/**
 * Scan package source for stampable literal credential keys and publish-time
 * gate failures (non-literal uses, unstampable legacy patterns, server eval).
 */
export function scanCredentialStamp(
	files: Record<string, string>,
): CredentialStampScan {
	const keys = new Set<string>()
	const failures: Array<CredentialStampGateFailure> = []
	const oauthKeys = new Set<string>()
	const slots = readManifestCredentialSlots(files[packageManifestPath])
	const scan = scanPackageCredentials({
		files,
		slots: toInventorySlots(slots),
	})

	for (const reference of scan.references) {
		// `|scope=` is refused via the 0010 unstampable pattern list.
		if (reference.scope != null) continue
		if (packageCredentialSlotNamePattern.test(reference.name)) {
			keys.add(reference.name)
			if (reference.nameKind === 'integration') oauthKeys.add(reference.name)
		} else {
			failures.push({
				code: 'invalid_key',
				message: `Credential name "${reference.name}" is not a valid kody.credentials key (letter, then letters/numbers/dots/underscores/hyphens; max 64). Rename it and use the new literal key.`,
			})
		}
	}

	const jwtSignKeys: Array<string> = []
	for (const name of scan.jwtSignSecretNames) {
		if (packageCredentialSlotNamePattern.test(name)) {
			keys.add(name)
			jwtSignKeys.push(name)
		} else {
			failures.push({
				code: 'invalid_key',
				message: `secretJwtSign name "${name}" is not a valid kody.credentials key. Rename it to a valid literal key and declare it with a description.`,
			})
		}
	}
	if (scan.jwtSignCalls > scan.jwtSignSecretNames.length) {
		failures.push({
			code: 'non_literal',
			message: nonLiteralFixMessage(
				'secretJwtSign was called with a non-literal private_key_secret_name.',
			),
		})
	}

	scanModuleCredentialReferences(files, (path) => ({
		add: () => {},
		named: (name, kind) => {
			if (packageCredentialSlotNamePattern.test(name)) {
				keys.add(name)
				if (kind === 'integration') oauthKeys.add(name)
			}
		},
		// Non-literal helper args are refused via 0010 unstampable patterns.
		computed: () => {},
		unnamed: (via) => {
			if (via === 'placeholder') {
				failures.push({
					code: 'unstampable_pattern',
					path,
					message: `${path}: vault placeholder {{secret/provider:ref}} cannot be stamped. Declare a kody.credentials slot keyed by the provider with a description, and use that literal key.`,
				})
			}
		},
	}))

	const modulePaths = listScannableModulePaths(files)
	const parsedModules = new Map(
		modulePaths.map((path) => [path, parseModule(files[path]!)]),
	)
	const moduleConstants = createModuleConstantsReader(parsedModules)
	for (const path of modulePaths) {
		const keyScan: KeyScan = {
			key: (key) => {
				if (packageCredentialSlotNamePattern.test(key)) keys.add(key)
				else {
					failures.push({
						code: 'invalid_key',
						path,
						message: `${path}: credential("${key}") is not a valid kody.credentials key. Rename it.`,
					})
				}
			},
			computed: () => {
				failures.push({
					code: 'non_literal',
					path,
					message: nonLiteralFixMessage(
						`${path}: credential() / credentials() was called with a non-literal key.`,
					),
				})
			},
			named: () => {
				failures.push({
					code: 'credential_named',
					path,
					message: `${path}: credential.named() is only for ad hoc execute and unshared personal-org packages (not stamped). Declare each credential in kody.credentials with a description and call credential("KEY") with a string literal.`,
				})
			},
			indirect: () => {
				failures.push({
					code: 'non_literal',
					path,
					message: `${path}: passes credential/credentials around instead of calling it with a literal key. Call credential("KEY") at each use site so publish can stamp the key.`,
				})
			},
		}
		const parsed = parsedModules.get(path)
		if (parsed) scanParsedCredentialKeys(parsed, moduleConstants(path), keyScan)
		else scanUnparsedCredentialKeys(files[path]!, keyScan)
	}

	const mcp = scanLiteralMcpServerKeys(files)
	for (const key of mcp.keys) keys.add(key)
	failures.push(...mcp.failures)

	for (const finding of detectLegacyCredentialPatternsCodemod.detect(files, {
		packageName: '',
	})) {
		const pattern = legacyCredentialPatternFromMessage(finding.message)
		if (pattern == null || !unstampableLegacyPatterns.has(pattern)) continue
		failures.push({
			code: 'unstampable_pattern',
			...(finding.path ? { path: finding.path } : {}),
			message: `${finding.path ?? 'package'}: ${finding.message} This pattern cannot be sealed into the credential stamp, so publish fails. ${unstampablePatternFix(pattern)}`,
		})
	}

	failures.push(
		...scanServerEvalFailures(files, collectServerRuntimeModulePaths(files)),
	)

	const sortedKeys = [...keys].sort()
	const staleManifestKeys = Object.keys(slots)
		.filter((key) => !keys.has(key))
		.sort()

	const missingDescriptions = sortedKeys.filter(
		(key) => slotDescription(slots, key) == null,
	)
	if (missingDescriptions.length > 0) {
		failures.push({
			code: 'missing_description',
			message: missingDescriptionMessage(missingDescriptions, slots),
		})
	}

	return {
		keys: sortedKeys,
		failures: dedupeFailures(failures),
		staleManifestKeys,
		mcpKeys: mcp.keys,
		jwtSignKeys: [...jwtSignKeys].sort(),
		oauthKeys: [...oauthKeys].sort(),
		scan,
	}
}

function unstampablePatternFix(pattern: LegacyCredentialPattern): string {
	switch (pattern) {
		case 'computed secret':
		case 'computed integration':
			return 'Declare every credential it can pick in kody.credentials with a description, and branch with literal names only.'
		case '|scope=':
			return 'Remove |scope= and use an org credential assigned to the package, declared in kody.credentials.'
		case 'secretMounts':
			return 'Delete kody.secretMounts and declare each credential in kody.credentials with a description; use credential("KEY") or {{secret:KEY}}.'
		case 'packageSecrets.get':
			return 'Replace packageSecrets.get with credential("KEY") after declaring the slot in kody.credentials.'
		case 'plain http':
			return 'Use https:// for any request that carries a credential placeholder.'
		case 'kody.mcp':
		case 'literal secret':
		case 'webhook secretName':
			return 'Declare the name in kody.credentials with a description.'
		default: {
			const exhaustive: never = pattern
			return `Unhandled pattern: ${String(exhaustive)}`
		}
	}
}

function missingDescriptionMessage(
	missing: ReadonlyArray<string>,
	slots: Record<string, ManifestCredentialSlot>,
) {
	const example = Object.fromEntries(
		missing.map((name) => {
			const existing = slots[name]
			return [
				name,
				{
					...(existing?.kind ? { kind: existing.kind } : {}),
					...(existing?.provider ? { provider: existing.provider } : {}),
					description: `Describe what ${name} is for.`,
				},
			]
		}),
	)
	return `Credential stamp keys missing a description in kody.credentials: ${missing.join(', ')}. Placeholder descriptions are not allowed — write what each credential is for in package.json, then publish again. Example:\n\n"kody": {\n  "credentials": ${JSON.stringify(example, null, 2).replace(/\n/g, '\n  ')}\n}\n\nPublish seals every stamped key into kody.credentials and never overwrites a description you already wrote.`
}

function dedupeFailures(failures: Array<CredentialStampGateFailure>) {
	const seen = new Set<string>()
	const out: Array<CredentialStampGateFailure> = []
	for (const failure of failures) {
		const id = `${failure.code}:${failure.path ?? ''}:${failure.message}`
		if (seen.has(id)) continue
		seen.add(id)
		out.push(failure)
	}
	return out
}

/**
 * Add stamp keys missing from `kody.credentials` without touching existing
 * descriptions. New keys are inserted without a description so the publish
 * gate can require a real one (no placeholders).
 */
export function mergeCredentialStampIntoManifestFiles(
	files: Record<string, string>,
	keys: ReadonlyArray<string>,
): { files: Record<string, string>; addedKeys: Array<string> } {
	const source = files[packageManifestPath]
	if (source == null || keys.length === 0) {
		return { files, addedKeys: [] }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return { files, addedKeys: [] }
	}
	if (!isPlainObject(parsed)) return { files, addedKeys: [] }
	const kody = isPlainObject(parsed.kody) ? { ...parsed.kody } : {}
	const existing = isPlainObject(kody.credentials)
		? { ...kody.credentials }
		: {}
	const addedKeys: Array<string> = []
	for (const key of keys) {
		if (Object.hasOwn(existing, key)) continue
		existing[key] = {}
		addedKeys.push(key)
	}
	if (addedKeys.length === 0) return { files, addedKeys: [] }
	const indent = detectJsonIndent(source)
	const next = `${JSON.stringify(
		{ ...parsed, kody: { ...kody, credentials: existing } },
		null,
		indent,
	)}\n`
	return {
		files: { ...files, [packageManifestPath]: next },
		addedKeys,
	}
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

/** Content hash over sorted keys and dependency stamp pins. */
export async function computeCredentialStampHash(input: {
	keys: ReadonlyArray<string>
	depStamps: ReadonlyArray<CredentialDepStamp>
}): Promise<string> {
	const payload = {
		keys: [...input.keys].sort(),
		depStamps: [...input.depStamps]
			.map((dep) => ({
				packageId: dep.packageId,
				publishedCommit: dep.publishedCommit,
				stampHash: dep.stampHash,
			}))
			.sort((left, right) => left.packageId.localeCompare(right.packageId)),
	}
	return sha256Hex(canonicalJsonStringify(payload))
}

export async function buildCredentialStamp(input: {
	keys: ReadonlyArray<string>
	depStamps?: ReadonlyArray<CredentialDepStamp>
}): Promise<CredentialStamp> {
	const keys = [...input.keys].sort()
	const depStamps = [...(input.depStamps ?? [])].sort((left, right) =>
		left.packageId.localeCompare(right.packageId),
	)
	const stampHash = await computeCredentialStampHash({ keys, depStamps })
	return {
		version: credentialStampVersion,
		keys,
		depStamps,
		stampHash,
	}
}
