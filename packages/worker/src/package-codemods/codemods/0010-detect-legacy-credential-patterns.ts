import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
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
const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

const placeholderOpenerPattern =
	/\{\{(secret-basic:|secret:|secret\/|integration-token:)/g
const completePlaceholderPatterns: Record<string, RegExp> = {
	'secret:': /\{\{secret:[a-zA-Z0-9._-]+(?:\|scope=[a-z]+)?\}\}/y,
	'secret-basic:':
		/\{\{secret-basic:username=[a-zA-Z0-9._-]+,password=[a-zA-Z0-9._-]+(?:\|scope=[a-z]+)?\}\}/y,
	'secret/': /\{\{secret\/[a-zA-Z0-9._-]+:[^}]+\}\}/y,
	'integration-token:': /\{\{integration-token:[a-zA-Z0-9._-]+\}\}/y,
}
const scopeSuffixPattern = /\|scope=(?:session|package|user)\b/
const textKodyMcpPattern =
	/\bkody\s*(?:\?\.|\.)\s*mcp\b|\bkody\s*\[\s*['"`]mcp['"`]/

type NameKind = 'secret' | 'integration'

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

/** Helper calls whose first argument (or named fields) name a credential. */
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

type AstNode = ModuleAstNode & {
	computed?: boolean
	name?: unknown
	value?: unknown
	object?: AstNode
	property?: AstNode
	callee?: AstNode
	arguments?: Array<AstNode>
	properties?: Array<AstNode>
	key?: AstNode
	id?: AstNode
	init?: AstNode
	expressions?: Array<AstNode>
	quasis?: Array<AstNode>
	source?: AstNode
	specifiers?: Array<AstNode>
	local?: AstNode
	imported?: AstNode
	program?: { body?: Array<AstNode> }
}

function getNodeName(node: AstNode | null | undefined) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

function walkAst(node: AstNode, visit: (node: AstNode) => void) {
	visit(node)
	for (const [key, value] of Object.entries(node)) {
		if (
			key === 'loc' ||
			key === 'range' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'innerComments' ||
			key === 'comments'
		) {
			continue
		}
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object' && 'type' in child) {
					walkAst(child as AstNode, visit)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, visit)
		}
	}
}

function classifyStringPiece(
	text: string,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	if (scopeSuffixPattern.test(text)) add('|scope=')
	for (const match of text.matchAll(placeholderOpenerPattern)) {
		const opener = match[1]!
		const complete = completePlaceholderPatterns[opener]!
		complete.lastIndex = match.index
		if (complete.test(text)) {
			add('literal secret')
		} else if (opener === 'integration-token:') {
			add('computed integration')
		} else {
			add('computed secret')
		}
	}
}

function isLiteralString(node: AstNode | undefined) {
	if (!node) return false
	if (node.type === 'StringLiteral') return true
	return (
		node.type === 'TemplateLiteral' && (node.expressions ?? []).length === 0
	)
}

function classifyNameExpression(
	node: AstNode | undefined,
	kind: NameKind,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	if (isLiteralString(node)) {
		add('literal secret')
		return
	}
	add(computedPattern(kind))
}

function computedPattern(kind: NameKind): LegacyCredentialPattern {
	return kind === 'integration' ? 'computed integration' : 'computed secret'
}

function getCalleeName(callee: AstNode | undefined) {
	if (!callee) return null
	if (callee.type === 'Identifier') return getNodeName(callee)
	if (
		(callee.type === 'MemberExpression' ||
			callee.type === 'OptionalMemberExpression') &&
		callee.computed !== true
	) {
		return getNodeName(callee.property)
	}
	return null
}

function getCalleeObjectName(callee: AstNode | undefined) {
	if (
		callee &&
		(callee.type === 'MemberExpression' ||
			callee.type === 'OptionalMemberExpression')
	) {
		return getNodeName(callee.object)
	}
	return null
}

function classifyNamedFields(
	argument: AstNode | undefined,
	spec: (typeof nameFieldCallees)[string],
	add: (pattern: LegacyCredentialPattern) => void,
) {
	if (argument?.type !== 'ObjectExpression') {
		if (argument) add(computedPattern(spec.kind))
		return
	}
	for (const property of argument.properties ?? []) {
		if (property.type !== 'ObjectProperty' || property.computed === true) {
			add(computedPattern(spec.kind))
			continue
		}
		const key = getNodeName(property.key)
		if (key == null) continue
		if (spec.scopeFields.includes(key)) {
			add('|scope=')
			continue
		}
		if (spec.fields.includes(key)) {
			classifyNameExpression(property.value as AstNode, spec.kind, add)
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

function detectInParsedModule(
	parsed: AstNode,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	const body = parsed.program?.body ?? []
	const aliases = collectKodyAliases(body)
	walkAst(parsed, (node) => {
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value) classifyStringPiece(value, add)
				return
			}
			case 'TemplateElement': {
				const value = node.value as { cooked?: string | null; raw?: string }
				classifyStringPiece(value.cooked ?? value.raw ?? '', add)
				return
			}
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
				const nameKind = nameArgumentCallees[calleeName]
				if (nameKind) {
					if (firstArgument)
						classifyNameExpression(firstArgument, nameKind, add)
					return
				}
				const objectName = getCalleeObjectName(node.callee)
				if (
					objectName === 'packageSecrets' &&
					packageSecretsMethods.has(calleeName)
				) {
					if (firstArgument)
						classifyNameExpression(firstArgument, 'secret', add)
					return
				}
				if (calleeName === 'basic' && objectName !== 'secretHeaders') return
				const fieldSpec = nameFieldCallees[calleeName]
				if (fieldSpec) classifyNamedFields(firstArgument, fieldSpec, add)
				return
			}
			default:
				return
		}
	})
}

/** Unparseable modules fall back to text: weaker, but never silent. */
function detectInUnparsedModule(
	source: string,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	classifyStringPiece(source, add)
	if (textKodyMcpPattern.test(source)) add('kody.mcp')
	for (const { pattern, kind } of textNameArgumentCalls) {
		for (const match of source.matchAll(pattern)) {
			add(match[1] ? 'literal secret' : computedPattern(kind))
		}
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
				add(match[1] ? 'literal secret' : computedPattern(spec.kind))
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
}

function detectLegacyCredentialPatterns(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		const patterns = new Set<LegacyCredentialPattern>()
		const add = (pattern: LegacyCredentialPattern) => patterns.add(pattern)
		if (path === packageManifestPath) {
			detectInManifest(source, add)
		} else if (scannableModuleFilePattern.test(path)) {
			let parsed: AstNode | null = null
			try {
				parsed = parseModuleSource(source) as unknown as AstNode
			} catch {
				parsed = null
			}
			if (parsed) detectInParsedModule(parsed, add)
			else detectInUnparsedModule(source, add)
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
		'Detect only (writes nothing): find packages that reference credentials the old way (literal or computed secret and integration names, kody.mcp, |scope=, kody.secretMounts, webhook secretName) ahead of kody.credentials slots.',
	detect: detectLegacyCredentialPatterns,
	transform: transformLegacyCredentialPatterns,
}
