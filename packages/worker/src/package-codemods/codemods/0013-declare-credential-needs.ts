import {
	type AstNode,
	constantsWithoutShadows,
	createModuleConstantsReader,
	getCalleeName,
	getNodeName,
	listScannableModulePaths,
	type NameKind,
	parseModule,
	resolveStringExpression,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import { packageCredentialSlotNamePattern } from '#worker/package-registry/types.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'
import {
	type CredentialReferenceVia,
	scanModuleCredentialReferences,
} from './0010-detect-legacy-credential-patterns.ts'

export const declareCredentialNeedsCodemodId = '0013-declare-credential-needs'

const packageManifestPath = 'package.json'

/** Written into each slot the codemod adds; owners can reword it. */
export const declaredCredentialSlotDescription =
	'Used by this package by name. Declared automatically from its source; describe what it is for.'

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const declareCredentialNeedsMessages = {
	declare:
		'Uses credentials by name that kody.credentials does not declare. Add a kody.credentials slot for each.',
	computed:
		'Builds a credential name or credential() key at run time. Declare each credential it can use as a kody.credentials slot by hand.',
	vault:
		'Uses a vault ref ({{secret/provider:ref}}). Declare a kody.credentials slot keyed by the provider by hand.',
	invalidKey:
		'Uses a credential name that is not a valid kody.credentials slot key (a letter, then letters, numbers, dots, underscores, or hyphens; max 64). Rename it or declare it by hand.',
	kindMismatch:
		'Uses a credential that kody.credentials declares with a kind that cannot fill it. Fix the slot kind by hand.',
	nonFetchCredential:
		'Calls credential() with an undeclared key in a module that signs or calls MCP tools. Declare the slot with its kind by hand.',
	indirectCredential:
		'Passes credential or credentials around instead of calling it. Declare each key it reads as a kody.credentials slot by hand.',
	invalidManifest:
		'package.json or its kody.credentials is not valid. Fix it, then declare each credential the package uses.',
} as const

/**
 * Helpers whose names reach the fetch gateway. The rest resolve a name
 * outside it (`secretJwtSign`, `integrationTokenRefresh`) or read a
 * `kody.secretMounts` alias, which counts as declared.
 */
const gatewayVias = new Set<CredentialReferenceVia>([
	'placeholder',
	'createAuthenticatedFetch',
	'basic',
	'oauthClientCredentials',
])

/** Declared slot kinds that can fill a placeholder of each name kind. */
const fillingSlotKinds: Record<NameKind, ReadonlySet<string>> = {
	secret: new Set(['secret']),
	integration: new Set(['oauth']),
}

type Use = 'secret' | 'integration' | 'credential'

type Plan = {
	add: Array<string>
	manual: Array<PackageCodemodFinding>
	manifest: Record<string, unknown> | null
	source: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseManifest(source: string | undefined) {
	if (source == null) return null
	try {
		const parsed: unknown = JSON.parse(source)
		return isPlainObject(parsed) ? parsed : null
	} catch {
		return null
	}
}

/** Mount aliases and the secret names they read are already declared. */
function secretMountNames(kody: Record<string, unknown>) {
	const names = new Set<string>()
	if (!isPlainObject(kody.secretMounts)) return names
	for (const [alias, mount] of Object.entries(kody.secretMounts)) {
		names.add(alias)
		if (isPlainObject(mount) && typeof mount.name === 'string') {
			names.add(mount.name)
		}
	}
	return names
}

const credentialFunctionNames = new Set(['credential', 'credentials'])

/** Local names bound to `credential` / `credentials` and the runtime object. */
function collectCredentialBindings(body: Array<AstNode>) {
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

function isCredentialCallee(
	callee: AstNode | undefined,
	bindings: ReturnType<typeof collectCredentialBindings>,
) {
	if (callee?.type === 'Identifier') {
		return bindings.functions.has(getNodeName(callee) ?? '')
	}
	if (
		(callee?.type === 'MemberExpression' ||
			callee?.type === 'OptionalMemberExpression') &&
		callee.computed !== true &&
		callee.object?.type === 'Identifier'
	) {
		return (
			bindings.runtimeObjects.has(getNodeName(callee.object) ?? '') &&
			credentialFunctionNames.has(getCalleeName(callee) ?? '')
		)
	}
	return false
}

type KeyScan = {
	key: (key: string) => void
	computed: () => void
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
			(node.type === 'CallExpression' ||
				node.type === 'OptionalCallExpression') &&
			isCredentialCallee(node.callee, bindings)
		) {
			const key = resolveStringExpression(
				node.arguments?.[0],
				constantsWithoutShadows(constants, ancestors),
			)
			if (key == null) scan.computed()
			else scan.key(key)
			return
		}
		if (node.type !== 'Identifier') return
		if (!bindings.functions.has(getNodeName(node) ?? '')) return
		const parent = ancestors.at(-1)
		if (!parent || parent.type.startsWith('Import')) return
		const isCallee =
			(parent.type === 'CallExpression' ||
				parent.type === 'OptionalCallExpression') &&
			parent.callee === node
		const isNamedAccess =
			(parent.type === 'MemberExpression' ||
				parent.type === 'OptionalMemberExpression') &&
			parent.object === node &&
			getNodeName(parent.property) === 'named'
		if (!isCallee && !isNamedAccess) scan.indirect()
	})
}

const textCredentialCallPattern =
	/\bcredentials?\s*\(\s*(?:(['"`])([^'"`$\\]*)\1)?/g

function scanUnparsedCredentialKeys(source: string, scan: KeyScan) {
	if (!/\bkody:runtime\b|\bkody\s*(?:\?\.|\.)\s*credentials?\b/.test(source)) {
		return
	}
	for (const match of source.matchAll(textCredentialCallPattern)) {
		if (match[2] == null) scan.computed()
		else scan.key(match[2])
	}
}

function planDeclarations(files: Record<string, string>): Plan {
	const source = Object.hasOwn(files, packageManifestPath)
		? files[packageManifestPath]
		: undefined
	const manifest = parseManifest(source)
	const kody = manifest?.kody
	const slots = isPlainObject(kody) ? kody.credentials : undefined
	if (
		source == null ||
		manifest == null ||
		(kody !== undefined && !isPlainObject(kody)) ||
		(slots !== undefined && !isPlainObject(slots))
	) {
		return {
			add: [],
			manual: [
				{
					path: packageManifestPath,
					message: declareCredentialNeedsMessages.invalidManifest,
				},
			],
			manifest: null,
			source: source ?? null,
		}
	}
	const declaredSlots = (slots ?? {}) as Record<string, unknown>
	const mounted = isPlainObject(kody) ? secretMountNames(kody) : new Set()
	const uses = new Map<string, Set<Use>>()
	const manual = new Map<
		string,
		Set<keyof typeof declareCredentialNeedsMessages>
	>()
	const flag = (
		path: string,
		message: keyof typeof declareCredentialNeedsMessages,
	) => {
		const messages = manual.get(path) ?? new Set()
		messages.add(message)
		manual.set(path, messages)
	}
	const pathsByName = new Map<string, Set<string>>()
	const use = (path: string, name: string, kind: Use) => {
		const kinds = uses.get(name) ?? new Set()
		kinds.add(kind)
		uses.set(name, kinds)
		const paths = pathsByName.get(name) ?? new Set()
		paths.add(path)
		pathsByName.set(name, paths)
	}
	scanModuleCredentialReferences(files, (path) => ({
		add: () => {},
		named: (name, kind, via) => {
			if (gatewayVias.has(via)) use(path, name, kind)
		},
		computed: (_kind, via) => {
			if (gatewayVias.has(via)) flag(path, 'computed')
		},
		unnamed: (via) => {
			if (via === 'placeholder') flag(path, 'vault')
		},
	}))
	const modulePaths = listScannableModulePaths(files)
	const parsedModules = new Map(
		modulePaths.map((path) => [path, parseModule(files[path]!)]),
	)
	const moduleConstants = createModuleConstantsReader(parsedModules)
	for (const path of modulePaths) {
		const parsed = parsedModules.get(path)
		const keys = new Set<string>()
		const scan: KeyScan = {
			key: (key) => keys.add(key),
			computed: () => flag(path, 'computed'),
			indirect: () => flag(path, 'indirectCredential'),
		}
		if (parsed) scanParsedCredentialKeys(parsed, moduleConstants(path), scan)
		else scanUnparsedCredentialKeys(files[path]!, scan)
		const usesNonFetch = /\.\s*(?:sign|callTool)\b/.test(files[path]!)
		for (const key of keys) {
			if (usesNonFetch && !Object.hasOwn(declaredSlots, key)) {
				flag(path, 'nonFetchCredential')
				continue
			}
			use(path, key, 'credential')
		}
	}
	const add: Array<string> = []
	for (const [name, kinds] of [...uses].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const paths = [...(pathsByName.get(name) ?? [])]
		if (Object.hasOwn(declaredSlots, name)) {
			const slot = declaredSlots[name]
			const declaredKind = isPlainObject(slot) ? slot.kind : undefined
			if (declaredKind == null) continue
			const fills = [...kinds].every(
				(kind) =>
					kind === 'credential' ||
					fillingSlotKinds[kind].has(String(declaredKind)),
			)
			if (!fills) for (const path of paths) flag(path, 'kindMismatch')
			continue
		}
		if (!kinds.has('credential') && mounted.has(name)) continue
		if (!packageCredentialSlotNamePattern.test(name)) {
			for (const path of paths) flag(path, 'invalidKey')
			continue
		}
		add.push(name)
	}
	return {
		add,
		manual: [...manual]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([path, messages]) =>
				[...messages].map((message) => ({
					path,
					message: declareCredentialNeedsMessages[message],
				})),
			),
		manifest,
		source,
	}
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

function detectDeclareCredentialNeeds(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const plan = planDeclarations(files)
	return [
		...(plan.add.length > 0
			? [
					{
						path: packageManifestPath,
						message: declareCredentialNeedsMessages.declare,
					},
				]
			: []),
		...plan.manual,
	]
}

function transformDeclareCredentialNeeds(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const plan = planDeclarations(files)
	if (plan.add.length === 0 || plan.manifest == null || plan.source == null) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: plan.manual,
		}
	}
	const kody = isPlainObject(plan.manifest.kody) ? plan.manifest.kody : {}
	const existing = isPlainObject(kody.credentials) ? kody.credentials : {}
	const credentials = {
		...existing,
		...Object.fromEntries(
			plan.add.map((name) => [
				name,
				{ description: declaredCredentialSlotDescription },
			]),
		),
	}
	const nextSource = `${JSON.stringify(
		{ ...plan.manifest, kody: { ...kody, credentials } },
		null,
		detectJsonIndent(plan.source),
	)}\n`
	return {
		files: { ...files, [packageManifestPath]: nextSource },
		changed: true,
		changedPaths: [packageManifestPath],
		needsManual: plan.manual,
	}
}

/**
 * Credential-need enforcement (issue #3822) limits a package run by someone
 * other than its author to the credentials it declares. This adds a
 * kind-less `kody.credentials` slot for every literal name the package fills
 * through the fetch gateway and every literal `credential()` key it reads,
 * so enforcement changes nothing for published packages. Names it cannot
 * read are left for the owner. Kept registered until enforcement is on and
 * a scoped rescan is clean.
 */
export const declareCredentialNeedsCodemod: PackageCodemod = {
	id: declareCredentialNeedsCodemodId,
	description:
		'Declare a kody.credentials slot for each credential a package uses by literal name (placeholders, createAuthenticatedFetch, secretHeaders.basic, oauthClientCredentials, credential() keys); flag computed names for manual review.',
	applyMode: 'published-only',
	detect: detectDeclareCredentialNeeds,
	transform: transformDeclareCredentialNeeds,
}
