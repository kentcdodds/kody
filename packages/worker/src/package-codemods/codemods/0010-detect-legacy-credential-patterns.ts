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
		'packageSecrets.get: reads a secret through packageSecrets.get. The ref it returns works only in the header its slot declares; reading the value itself needs a raw slot.',
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

function walkAst(
	node: AstNode,
	visit: (node: AstNode, ancestors: ReadonlyArray<AstNode>) => void,
	ancestors: Array<AstNode> = [],
) {
	visit(node, ancestors)
	ancestors.push(node)
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
					walkAst(child as AstNode, visit, ancestors)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, visit, ancestors)
		}
	}
	ancestors.pop()
}

function literalText(node: AstNode) {
	if (node.type === 'StringLiteral') return getNodeName(node)
	if (node.type !== 'TemplateLiteral') return null
	return (node.quasis ?? [])
		.map((quasi) => {
			const value = quasi.value as { cooked?: string | null; raw?: string }
			return value.cooked ?? value.raw ?? ''
		})
		.join('${}')
}

function isWithinHeaders(node: AstNode, ancestors: ReadonlyArray<AstNode>) {
	let child = node
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const parent = ancestors[index]!
		if (
			parent.type === 'ObjectProperty' &&
			parent.computed !== true &&
			parent.value === child &&
			getNodeName(parent.key) === 'headers'
		) {
			return true
		}
		if (
			parent.type === 'NewExpression' &&
			getNodeName(parent.callee) === 'Headers'
		) {
			return true
		}
		child = parent
	}
	return false
}

/**
 * True only when the literal provably lands in a request URL, query, or body:
 * a URL-shaped string, a `body` property, the URL argument of `fetch`,
 * `new Request`, or `new URL`, or `JSON.stringify` / `URLSearchParams` /
 * `FormData` input. Anything under a `headers` property or `new Headers` is a
 * header, so the count stays a floor.
 */
function literalIsOutsideHeader(
	node: AstNode,
	text: string,
	ancestors: ReadonlyArray<AstNode>,
) {
	if (isWithinHeaders(node, ancestors)) return false
	if (/^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text)) return true
	let child = node
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const parent = ancestors[index]!
		if (
			parent.type === 'ObjectProperty' &&
			parent.computed !== true &&
			parent.value === child &&
			getNodeName(parent.key) === 'body'
		) {
			return true
		}
		if (
			parent.type === 'CallExpression' ||
			parent.type === 'OptionalCallExpression'
		) {
			const calleeName = getCalleeName(parent.callee)
			if (calleeName === 'fetch' && parent.arguments?.[0] === child) {
				return true
			}
			if (
				calleeName === 'stringify' &&
				getCalleeObjectName(parent.callee) === 'JSON'
			) {
				return true
			}
		}
		if (parent.type === 'NewExpression') {
			const constructorName = getNodeName(parent.callee)
			if (
				(constructorName === 'Request' || constructorName === 'URL') &&
				parent.arguments?.[0] === child
			) {
				return true
			}
			if (
				constructorName === 'URLSearchParams' ||
				constructorName === 'FormData'
			) {
				return true
			}
		}
		child = parent
	}
	return false
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
	let usesPlaceholder = false
	let fetchesPlainHttp = false
	const classifyLiteral = (
		node: AstNode,
		ancestors: ReadonlyArray<AstNode>,
	) => {
		const text = literalText(node)
		if (text == null) return
		if (isPlainHttpUrl(text) && isRequestUrlArgument(node, ancestors.at(-1))) {
			fetchesPlainHttp = true
		}
		if (!new RegExp(placeholderOpenerPattern.source).test(text)) return
		usesPlaceholder = true
		if (literalIsOutsideHeader(node, text, ancestors)) {
			add('secret outside header')
		}
	}
	walkAst(parsed, (node, ancestors) => {
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value) classifyStringPiece(value, add)
				classifyLiteral(node, ancestors)
				return
			}
			case 'TemplateLiteral': {
				classifyLiteral(node, ancestors)
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
					if (calleeName === 'get') add('packageSecrets.get')
					if (firstArgument)
						classifyNameExpression(firstArgument, 'secret', add)
					return
				}
				if (calleeName === 'packageSecretGet') add('packageSecrets.get')
				if (calleeName === 'basic' && objectName !== 'secretHeaders') return
				const fieldSpec = nameFieldCallees[calleeName]
				if (fieldSpec) classifyNamedFields(firstArgument, fieldSpec, add)
				return
			}
			default:
				return
		}
	})
	if (usesPlaceholder && fetchesPlainHttp) add('plain http')
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
		'Detect only (writes nothing): find packages that reference credentials the old way (literal or computed secret and integration names, kody.mcp, |scope=, kody.secretMounts, webhook secretName) ahead of kody.credentials slots, and code the fetch gateway secret rules refuse (placeholders outside headers, plain http, packageSecrets.get, secret slots without placement).',
	detect: detectLegacyCredentialPatterns,
	transform: transformLegacyCredentialPatterns,
}
