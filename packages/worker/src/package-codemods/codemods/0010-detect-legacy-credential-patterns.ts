import {
	type AstNode,
	createModuleConstantsReader,
	findPlaceholders,
	getCalleeName,
	getCalleeObjectName,
	getNodeName,
	literalLocationOutsideHeader,
	type NameKind,
	parseModule,
	resolveStringExpression,
	scannableModuleFilePattern,
	testFilePattern,
	visitModuleStrings,
	walkAst,
} from '#worker/credentials/placeholder-placement-scan.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const detectLegacyCredentialPatternsCodemodId =
	'0010-detect-legacy-credential-patterns'

export const legacyCredentialPatterns = [
	'literal secret',
	'computed secret',
	'computed integration',
	'kody.mcp',
	'|scope=',
	'secretMounts',
	'webhook secretName',
	'secret outside header',
	'plain http',
	'packageSecrets.get',
	'missing placement',
] as const

export type LegacyCredentialPattern = (typeof legacyCredentialPatterns)[number]

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const legacyCredentialPatternMessages: Record<
	LegacyCredentialPattern,
	string
> = {
	'literal secret':
		'literal secret: names a secret, vault ref, or integration with a literal string. Declare it as a kody.credentials slot.',
	'computed secret':
		'computed secret: builds a secret name or placeholder at runtime. Declare each secret it can pick as a kody.credentials slot.',
	'computed integration':
		'computed integration: picks an integration name at runtime. Declare a kody.credentials oauth slot (multiple when it picks among accounts).',
	'kody.mcp':
		'kody.mcp: calls an MCP server by name. Declare a kody.credentials mcp slot for each server.',
	'|scope=':
		'|scope=: reads a package- or session-scoped secret bucket. Move the value to an org credential assigned to the package.',
	secretMounts:
		'secretMounts: declares kody.secretMounts. Replace each mount with a kody.credentials slot.',
	'webhook secretName':
		'webhook secretName: a webhook names its signing secret with secretName. Declare that secret as a kody.credentials slot.',
	'secret outside header':
		'secret outside header: puts a secret placeholder in a request URL, query, or body. The fetch gateway substitutes secrets only into the header a kody.credentials slot declares.',
	'plain http':
		'plain http: fetches an http:// URL in a module that uses secret placeholders. The fetch gateway substitutes secrets only over HTTPS.',
	'packageSecrets.get':
		'packageSecrets.get: reads a kody.secretMounts alias through packageSecrets.get. It returns an opaque {{secret:…}} ref, never the value. The fetch gateway fills the ref in only in the header a kody.credentials slot declares for that secret.',
	'missing placement':
		'missing placement: a kody.credentials secret slot has no placement. Publish requires the header the value goes in.',
}

export function legacyCredentialPatternFromMessage(
	message: string,
): LegacyCredentialPattern | null {
	for (const pattern of legacyCredentialPatterns) {
		if (legacyCredentialPatternMessages[pattern] === message) return pattern
	}
	return null
}

const packageManifestPath = 'package.json'
/** The kody.credentials slot kind a reference of each name kind resolves to. */
const slotKindByNameKind: Record<NameKind, 'secret' | 'oauth'> = {
	secret: 'secret',
	integration: 'oauth',
}

type Scan = {
	add: (pattern: LegacyCredentialPattern) => void
	/**
	 * A credential named by a known string. Not a finding when it names a
	 * declared kody.credentials slot of the matching kind.
	 */
	named: (name: string, kind: NameKind) => void
	/** Module-level string constants, declared or relatively imported. */
	constants: ReadonlyMap<string, string>
}
/**
 * A literal scope, or `|scope=` followed by a computed value: the end of a
 * string piece (the AST splits templates and concatenations into pieces), or
 * `${` / a closing quote and `+` in the text fallback.
 */
const scopeSuffixPattern =
	/\|scope=(?:(?:session|package|user)\b|$|\$\{|['"`]\s*\+)/
const textKodyMcpPattern =
	/\bkody\s*(?:\?\.|\.)\s*mcp\b|\bkody\s*\[\s*['"`]mcp['"`]/

/** Group 1 captures the opening quote when the first argument is a literal. */
const textNameArgumentCalls: Array<{ pattern: RegExp; kind: NameKind }> = [
	{
		pattern: /\bcreateAuthenticatedFetch\s*\(\s*(['"`])?/g,
		kind: 'integration',
	},
	{
		pattern: /\bpackageSecrets\s*(?:\?\.|\.)\s*(?:get|has)\s*\(\s*(['"`])?/g,
		kind: 'secret',
	},
]

/**
 * Helper calls whose first argument (or named fields) name a credential. Read
 * with {@link ownEntry}: a callee named after an Object.prototype method
 * (`toString`, `hasOwnProperty`) must not match.
 */
const nameArgumentCallees: Record<string, NameKind> = {
	createAuthenticatedFetch: 'integration',
}
const nameFieldCallees: Record<
	string,
	{ kind: NameKind; fields: Array<string>; scopeFields: Array<string> }
> = {
	basic: {
		kind: 'secret',
		fields: ['usernameSecret', 'passwordSecret'],
		scopeFields: ['scope'],
	},
	oauthClientCredentials: {
		kind: 'secret',
		fields: ['clientIdSecret', 'clientSecretSecret'],
		scopeFields: ['scope'],
	},
	secretJwtSign: {
		kind: 'secret',
		fields: ['private_key_secret_name'],
		scopeFields: ['private_key_secret_scope'],
	},
	packageSecretGet: { kind: 'secret', fields: ['alias'], scopeFields: [] },
	packageSecretHas: { kind: 'secret', fields: ['alias'], scopeFields: [] },
	integrationTokenRefresh: {
		kind: 'integration',
		fields: ['name'],
		scopeFields: [],
	},
}
const packageSecretsMethods = new Set(['get', 'has'])

function ownEntry<Value>(record: Record<string, Value>, key: string) {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

function isPlainHttpUrl(text: string) {
	return /^\s*http:\/\//i.test(text)
}

function isRequestUrlArgument(node: AstNode, parent: AstNode | undefined) {
	if (!parent || parent.arguments?.[0] !== node) return false
	if (parent.type === 'NewExpression') {
		return getNodeName(parent.callee) === 'Request'
	}
	return (
		(parent.type === 'CallExpression' ||
			parent.type === 'OptionalCallExpression') &&
		getCalleeName(parent.callee) === 'fetch'
	)
}

function classifyStringPiece(text: string, scan: Scan) {
	if (scopeSuffixPattern.test(text)) scan.add('|scope=')
	for (const placeholder of findPlaceholders(text)) {
		switch (placeholder.kind) {
			case 'secret':
			case 'integration':
				for (const name of placeholder.names) {
					scan.named(name, placeholder.kind)
				}
				break
			case 'vault':
				scan.add('literal secret')
				break
			case 'computed':
				scan.add(computedPattern(placeholder.nameKind))
				break
			default: {
				const exhaustive: never = placeholder
				throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
			}
		}
	}
}

function classifyNameExpression(
	node: AstNode | undefined,
	kind: NameKind,
	scan: Scan,
) {
	const name = resolveStringExpression(node, scan.constants)
	if (name == null) scan.add(computedPattern(kind))
	else scan.named(name, kind)
}

function computedPattern(kind: NameKind): LegacyCredentialPattern {
	return kind === 'integration' ? 'computed integration' : 'computed secret'
}

function classifyNamedFields(
	argument: AstNode | undefined,
	spec: (typeof nameFieldCallees)[string],
	scan: Scan,
) {
	if (argument?.type !== 'ObjectExpression') {
		if (argument) scan.add(computedPattern(spec.kind))
		return
	}
	for (const property of argument.properties ?? []) {
		if (property.type !== 'ObjectProperty' || property.computed === true) {
			scan.add(computedPattern(spec.kind))
			continue
		}
		const key = getNodeName(property.key)
		if (key == null) continue
		if (spec.scopeFields.includes(key)) {
			scan.add('|scope=')
			continue
		}
		if (spec.fields.includes(key)) {
			classifyNameExpression(property.value as AstNode, spec.kind, scan)
		}
	}
}

function collectKodyAliases(body: Array<AstNode>) {
	const aliases = new Set<string>(['kody'])
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ImportSpecifier') continue
			if (getNodeName(specifier.imported) !== 'kody') continue
			const local = getNodeName(specifier.local)
			if (local) aliases.add(local)
		}
	}
	return aliases
}

function isKodyMcpAccess(node: AstNode, aliases: Set<string>) {
	if (
		node.type !== 'MemberExpression' &&
		node.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	if (node.object?.type !== 'Identifier') return false
	if (!aliases.has(getNodeName(node.object) ?? '')) return false
	return getNodeName(node.property) === 'mcp'
}

function isKodyMcpDestructure(node: AstNode, aliases: Set<string>) {
	if (node.type !== 'VariableDeclarator') return false
	if (node.id?.type !== 'ObjectPattern') return false
	if (node.init?.type !== 'Identifier') return false
	if (!aliases.has(getNodeName(node.init) ?? '')) return false
	return (node.id.properties ?? []).some(
		(property) =>
			property.type === 'ObjectProperty' && getNodeName(property.key) === 'mcp',
	)
}

function detectInParsedModule(parsed: AstNode, scan: Scan) {
	const { add } = scan
	const body = parsed.program?.body ?? []
	const aliases = collectKodyAliases(body)
	let usesPlaceholder = false
	let fetchesPlainHttp = false
	visitModuleStrings(
		parsed,
		scan.constants,
		({ node, text, pieces, ancestors }) => {
			for (const piece of pieces) classifyStringPiece(piece, scan)
			if (
				isPlainHttpUrl(text) &&
				isRequestUrlArgument(node, ancestors.at(-1))
			) {
				fetchesPlainHttp = true
			}
			if (findPlaceholders(text).length === 0) return
			usesPlaceholder = true
			if (literalLocationOutsideHeader(node, text, ancestors)) {
				add('secret outside header')
			}
		},
	)
	walkAst(parsed, (node) => {
		switch (node.type) {
			case 'VariableDeclarator': {
				if (isKodyMcpDestructure(node, aliases)) add('kody.mcp')
				return
			}
			case 'MemberExpression':
			case 'OptionalMemberExpression': {
				if (isKodyMcpAccess(node, aliases)) add('kody.mcp')
				return
			}
			case 'CallExpression':
			case 'OptionalCallExpression': {
				const calleeName = getCalleeName(node.callee)
				if (calleeName == null) return
				const firstArgument = node.arguments?.[0]
				const nameKind = ownEntry(nameArgumentCallees, calleeName)
				if (nameKind) {
					if (firstArgument)
						classifyNameExpression(firstArgument, nameKind, scan)
					return
				}
				const objectName = getCalleeObjectName(node.callee)
				if (
					objectName === 'packageSecrets' &&
					packageSecretsMethods.has(calleeName)
				) {
					if (calleeName === 'get') add('packageSecrets.get')
					if (firstArgument)
						classifyNameExpression(firstArgument, 'secret', scan)
					return
				}
				if (calleeName === 'packageSecretGet') add('packageSecrets.get')
				if (calleeName === 'basic' && objectName !== 'secretHeaders') return
				const fieldSpec = ownEntry(nameFieldCallees, calleeName)
				if (fieldSpec) classifyNamedFields(firstArgument, fieldSpec, scan)
				return
			}
			default:
				return
		}
	})
	if (usesPlaceholder && fetchesPlainHttp) add('plain http')
}

/** Unparseable modules fall back to text: weaker, but never silent. */
function detectInUnparsedModule(source: string, scan: Scan) {
	const { add } = scan
	/** The quoted name opened at `match`, or a computed finding. */
	const classifyQuoted = (match: RegExpMatchArray, kind: NameKind) => {
		const quote = match[1]
		if (!quote) {
			add(computedPattern(kind))
			return
		}
		const start = match.index! + match[0].length
		const end = source.indexOf(quote, start)
		if (end === -1) add('literal secret')
		else scan.named(source.slice(start, end), kind)
	}
	classifyStringPiece(source, scan)
	if (textKodyMcpPattern.test(source)) add('kody.mcp')
	for (const { pattern, kind } of textNameArgumentCalls) {
		for (const match of source.matchAll(pattern)) classifyQuoted(match, kind)
	}
	if (
		/\bpackageSecrets\s*(?:\?\.|\.)\s*get\s*\(|\bpackageSecretGet\s*\(/.test(
			source,
		)
	) {
		add('packageSecrets.get')
	}
	for (const [callee, spec] of Object.entries(nameFieldCallees)) {
		const call =
			callee === 'basic'
				? /\bsecretHeaders\s*(?:\?\.|\.)\s*basic\s*\(/
				: new RegExp(`\\b${callee}\\s*\\(`)
		if (!call.test(source)) continue
		let namedField = false
		for (const field of spec.fields) {
			for (const match of source.matchAll(
				new RegExp(`\\b${field}\\s*:\\s*(['"\`])?`, 'g'),
			)) {
				namedField = true
				classifyQuoted(match, spec.kind)
			}
		}
		if (!namedField) add(computedPattern(spec.kind))
		for (const field of spec.scopeFields) {
			if (new RegExp(`\\b${field}\\s*:`).test(source)) add('|scope=')
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function webhookNamesSecret(webhook: unknown) {
	if (!isPlainObject(webhook)) return false
	const verification = webhook.verification
	if (isPlainObject(verification) && verification.secretName != null) {
		return true
	}
	const challenge = webhook.challenge
	if (!isPlainObject(challenge)) return false
	const prove = challenge.prove
	return isPlainObject(prove) && prove.secretName != null
}

function detectInManifest(
	source: string,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return
	const kody = parsed.kody
	if ('secretMounts' in kody) add('secretMounts')
	if (Array.isArray(kody.webhooks) && kody.webhooks.some(webhookNamesSecret)) {
		add('webhook secretName')
	}
	if (
		isPlainObject(kody.credentials) &&
		Object.values(kody.credentials).some(
			(slot) =>
				isPlainObject(slot) && slot.kind === 'secret' && slot.placement == null,
		)
	) {
		add('missing placement')
	}
}

/** Declared kody.credentials slot names and their kinds. */
function readDeclaredSlotKinds(manifestSource: string | undefined) {
	const kinds = new Map<string, unknown>()
	if (manifestSource == null) return kinds
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return kinds
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return kinds
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return kinds
	for (const [name, slot] of Object.entries(credentials)) {
		if (isPlainObject(slot)) kinds.set(name, slot.kind)
	}
	return kinds
}

function detectLegacyCredentialPatterns(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	const manifestSource = Object.hasOwn(files, packageManifestPath)
		? files[packageManifestPath]
		: undefined
	const slotKinds = readDeclaredSlotKinds(manifestSource)
	const parsedModules = new Map<string, AstNode | null>()
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		if (!scannableModuleFilePattern.test(path) || testFilePattern.test(path)) {
			continue
		}
		parsedModules.set(path, parseModule(source))
	}
	const moduleConstants = createModuleConstantsReader(parsedModules)
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		const patterns = new Set<LegacyCredentialPattern>()
		const add = (pattern: LegacyCredentialPattern) => patterns.add(pattern)
		const scan: Scan = {
			add,
			named: (name, kind) => {
				if (slotKinds.get(name) !== slotKindByNameKind[kind]) {
					add('literal secret')
				}
			},
			constants: new Map(),
		}
		if (path === packageManifestPath) {
			detectInManifest(source, add)
		} else if (parsedModules.has(path)) {
			const parsed = parsedModules.get(path)
			if (parsed) {
				detectInParsedModule(parsed, {
					...scan,
					constants: moduleConstants(path),
				})
			} else {
				detectInUnparsedModule(source, scan)
			}
		}
		for (const pattern of legacyCredentialPatterns) {
			if (patterns.has(pattern)) {
				findings.push({
					path,
					message: legacyCredentialPatternMessages[pattern],
				})
			}
		}
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transformLegacyCredentialPatterns(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	return {
		files,
		changed: false,
		changedPaths: [],
		needsManual: detectLegacyCredentialPatterns(files),
	}
}

export const detectLegacyCredentialPatternsCodemod: PackageCodemod = {
	id: detectLegacyCredentialPatternsCodemodId,
	description:
		'Detect only (writes nothing): find packages that reference credentials the old way (literal or computed secret and integration names, kody.mcp, |scope=, kody.secretMounts, webhook secretName) ahead of kody.credentials slots, and code the fetch gateway secret rules refuse (placeholders outside headers, plain http, packageSecrets.get, secret slots without placement).',
	detect: detectLegacyCredentialPatterns,
	transform: transformLegacyCredentialPatterns,
}
