import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

/**
 * Static scan of package source for secret placeholders the fetch gateway
 * refuses: a placeholder that provably lands in a request URL, query, or body
 * instead of a header. Publish checks, `packageGet` warnings, and the 0010
 * fleet codemod share it so all three agree on what is refused.
 */

export const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
/**
 * Package tests are not runtime code: their fixtures name credentials the
 * package never resolves.
 */
export const testFilePattern =
	/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

export type NameKind = 'secret' | 'integration'

const placeholderOpenerPattern =
	/\{\{(secret-basic:|secret:|secret\/|integration-token:)/g
/** Capture groups are the names; a vault ref (`kind: null`) names no slot. */
const completePlaceholderPatterns: Record<
	string,
	{ pattern: RegExp; kind: NameKind | null }
> = {
	'secret:': {
		pattern: /\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=[a-z]+)?\}\}/y,
		kind: 'secret',
	},
	'secret-basic:': {
		pattern:
			/\{\{secret-basic:username=([a-zA-Z0-9._-]+),password=([a-zA-Z0-9._-]+)(?:\|scope=[a-z]+)?\}\}/y,
		kind: 'secret',
	},
	'secret/': { pattern: /\{\{secret\/[a-zA-Z0-9._-]+:[^}]+\}\}/y, kind: null },
	'integration-token:': {
		pattern: /\{\{integration-token:([a-zA-Z0-9._-]+)\}\}/y,
		kind: 'integration',
	},
}
/**
 * Placeholder-shaped text that closes in the same string piece but names
 * nothing, such as help or redaction text (`{{secret:<name>}}`). The gateway
 * never substitutes it. `$`, quotes, and `+` stay out so the text fallback
 * still sees `${name}` and concatenation as computed.
 */
const prosePlaceholderPattern =
	/\{\{(?:secret-basic:|secret:|secret\/|integration-token:)[^}$'"`+]*\}\}/y

export type Placeholder =
	| { kind: NameKind; names: Array<string> }
	| { kind: 'vault' }
	| { kind: 'computed'; nameKind: NameKind }

export function findPlaceholders(text: string) {
	const placeholders: Array<Placeholder> = []
	for (const match of text.matchAll(placeholderOpenerPattern)) {
		const opener = match[1]!
		const complete = completePlaceholderPatterns[opener]!
		complete.pattern.lastIndex = match.index
		const found = complete.pattern.exec(text)
		if (found) {
			placeholders.push(
				complete.kind
					? { kind: complete.kind, names: found.slice(1) }
					: { kind: 'vault' },
			)
			continue
		}
		prosePlaceholderPattern.lastIndex = match.index
		if (prosePlaceholderPattern.test(text)) continue
		placeholders.push({
			kind: 'computed',
			nameKind: opener === 'integration-token:' ? 'integration' : 'secret',
		})
	}
	return placeholders
}

export type AstNode = ModuleAstNode & {
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
	exported?: AstNode
	expression?: AstNode
	left?: AstNode
	right?: AstNode
	operator?: unknown
	declaration?: AstNode
	declarations?: Array<AstNode>
	program?: { body?: Array<AstNode> }
	loc?: { start?: { line?: number } }
}

const transparentExpressionTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
])

function unwrapExpression(node: AstNode | undefined) {
	let current = node
	while (current && transparentExpressionTypes.has(current.type)) {
		current = current.expression
	}
	return current
}

export function templateElementText(node: AstNode) {
	const value = node.value as { cooked?: string | null; raw?: string }
	return value.cooked ?? value.raw ?? ''
}

/** The string an expression always evaluates to, or null when computed. */
export function resolveStringExpression(
	node: AstNode | undefined,
	constants: ReadonlyMap<string, string>,
): string | null {
	const inner = unwrapExpression(node)
	switch (inner?.type) {
		case 'StringLiteral':
			return typeof inner.value === 'string' ? inner.value : null
		case 'Identifier':
			return constants.get(getNodeName(inner) ?? '') ?? null
		case 'TemplateLiteral': {
			const quasis = inner.quasis ?? []
			const expressions = inner.expressions ?? []
			let text = ''
			for (const [index, quasi] of quasis.entries()) {
				text += templateElementText(quasi)
				if (index >= expressions.length) continue
				const value = resolveStringExpression(expressions[index], constants)
				if (value == null) return null
				text += value
			}
			return text
		}
		case 'BinaryExpression': {
			if (inner.operator !== '+') return null
			const left = resolveStringExpression(inner.left, constants)
			if (left == null) return null
			const right = resolveStringExpression(inner.right, constants)
			return right == null ? null : left + right
		}
		default:
			return null
	}
}

/** `src/a.ts` + `../lib/names.js` → `lib/names.ts` when that file exists. */
function resolveRelativeModulePath(
	importer: string,
	specifier: string,
	modulePaths: ReadonlySet<string>,
) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
	const segments = importer.split('/').slice(0, -1)
	for (const part of specifier.split('/')) {
		if (part === '' || part === '.') continue
		if (part !== '..') segments.push(part)
		else if (segments.pop() === undefined) return null
	}
	const base = segments.join('/')
	const candidates = [
		base,
		base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2'),
		...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'].map(
			(suffix) => `${base}${suffix}`,
		),
	]
	return candidates.find((candidate) => modulePaths.has(candidate)) ?? null
}

/**
 * Top-level `const NAME = <string>` bindings of each module, plus names
 * imported from relative modules that export one. Inner scopes that shadow
 * a constant are not tracked.
 */
export function createModuleConstantsReader(
	parsedModules: ReadonlyMap<string, AstNode | null>,
) {
	const modulePaths = new Set(parsedModules.keys())
	const cache = new Map<
		string,
		{ constants: Map<string, string>; exported: Map<string, string> }
	>()
	const read = (path: string) => {
		const cached = cache.get(path)
		if (cached) return cached
		const result = {
			constants: new Map<string, string>(),
			exported: new Map<string, string>(),
		}
		// Set before reading imports so an import cycle ends at an empty map.
		cache.set(path, result)
		const body = parsedModules.get(path)?.program?.body ?? []
		for (const node of body) {
			if (node.type !== 'ImportDeclaration') continue
			const source = getNodeName(node.source)
			const target = source
				? resolveRelativeModulePath(path, source, modulePaths)
				: null
			if (!target) continue
			const { exported } = read(target)
			for (const specifier of node.specifiers ?? []) {
				if (specifier.type !== 'ImportSpecifier') continue
				const value = exported.get(getNodeName(specifier.imported) ?? '')
				const local = getNodeName(specifier.local)
				if (value != null && local) result.constants.set(local, value)
			}
		}
		const exportedNames = new Map<string, string>()
		for (const node of body) {
			const declaration =
				node.type === 'ExportNamedDeclaration' ? node.declaration : node
			if (
				declaration?.type === 'VariableDeclaration' &&
				declaration.kind === 'const'
			) {
				for (const declarator of declaration.declarations ?? []) {
					if (declarator.id?.type !== 'Identifier') continue
					const name = getNodeName(declarator.id)
					const value = resolveStringExpression(
						declarator.init,
						result.constants,
					)
					if (!name || value == null) continue
					result.constants.set(name, value)
					if (declaration !== node) exportedNames.set(name, name)
				}
			}
			if (node.type === 'ExportNamedDeclaration' && !node.source) {
				for (const specifier of node.specifiers ?? []) {
					const local = getNodeName(specifier.local)
					const exported = getNodeName(specifier.exported)
					if (local && exported) exportedNames.set(exported, local)
				}
			}
		}
		for (const [exported, local] of exportedNames) {
			const value = result.constants.get(local)
			if (value != null) result.exported.set(exported, value)
		}
		return result
	}
	return (path: string) => read(path).constants
}

export function getNodeName(node: AstNode | null | undefined) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

export function walkAst(
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

export function literalText(node: AstNode) {
	if (node.type === 'StringLiteral') return getNodeName(node)
	if (node.type !== 'TemplateLiteral') return null
	return (node.quasis ?? []).map(templateElementText).join('${}')
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

export type PlaceholderLocation = 'url' | 'body' | 'url or body'

/**
 * Where a literal provably lands outside a header: a URL-shaped string or the
 * URL argument of `fetch`, `new Request`, or `new URL`; a `body` property or
 * `JSON.stringify` / `FormData` input; or `URLSearchParams` input (a query
 * string or a form body). Null for anything under a `headers` property or
 * `new Headers`, and for anything not provably outside one, so callers see a
 * floor rather than guesses.
 */
export function literalLocationOutsideHeader(
	node: AstNode,
	text: string,
	ancestors: ReadonlyArray<AstNode>,
): PlaceholderLocation | null {
	if (isWithinHeaders(node, ancestors)) return null
	if (/^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text)) return 'url'
	let child = node
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const parent = ancestors[index]!
		if (
			parent.type === 'ObjectProperty' &&
			parent.computed !== true &&
			parent.value === child &&
			getNodeName(parent.key) === 'body'
		) {
			return 'body'
		}
		if (
			parent.type === 'CallExpression' ||
			parent.type === 'OptionalCallExpression'
		) {
			const calleeName = getCalleeName(parent.callee)
			if (calleeName === 'fetch' && parent.arguments?.[0] === child) {
				return 'url'
			}
			if (
				calleeName === 'stringify' &&
				getCalleeObjectName(parent.callee) === 'JSON'
			) {
				return 'body'
			}
		}
		if (parent.type === 'NewExpression') {
			const constructorName = getNodeName(parent.callee)
			if (
				(constructorName === 'Request' || constructorName === 'URL') &&
				parent.arguments?.[0] === child
			) {
				return 'url'
			}
			if (constructorName === 'URLSearchParams') return 'url or body'
			if (constructorName === 'FormData') return 'body'
		}
		child = parent
	}
	return null
}

export function getCalleeName(callee: AstNode | undefined) {
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

export function getCalleeObjectName(callee: AstNode | undefined) {
	if (
		callee &&
		(callee.type === 'MemberExpression' ||
			callee.type === 'OptionalMemberExpression')
	) {
		return getNodeName(callee.object)
	}
	return null
}

/** A template or `+` chain with a non-literal part, so it may be computed. */
export function isCompositeString(node: AstNode) {
	if (node.type === 'TemplateLiteral') {
		return (node.expressions ?? []).length > 0
	}
	return node.type === 'BinaryExpression' && node.operator === '+'
}

export function parseModule(source: string) {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}

/**
 * Visits every string an expression in the module can be, once: a composite
 * string that resolves through module constants as its whole value, and
 * every other string literal or template on its own.
 */
export function visitModuleStrings(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	visit: (input: {
		node: AstNode
		/** Whole resolved text, or the template text with `${}` for holes. */
		text: string
		/** Text pieces to classify for names (templates split at holes). */
		pieces: Array<string>
		ancestors: ReadonlyArray<AstNode>
	}) => void,
) {
	const resolvedPieces = new WeakSet<AstNode>()
	walkAst(parsed, (node, ancestors) => {
		if (resolvedPieces.has(node)) return
		if (isCompositeString(node)) {
			const resolved = resolveStringExpression(node, constants)
			if (resolved != null) {
				walkAst(node, (piece) => resolvedPieces.add(piece))
				visit({ node, text: resolved, pieces: [resolved], ancestors })
				return
			}
		}
		if (node.type === 'StringLiteral') {
			const value = getNodeName(node)
			if (value != null) {
				visit({ node, text: value, pieces: [value], ancestors })
			}
			return
		}
		if (node.type === 'TemplateLiteral') {
			const text = literalText(node)
			if (text == null) return
			visit({
				node,
				text,
				pieces: (node.quasis ?? []).map(templateElementText),
				ancestors,
			})
		}
	})
}

export type MisplacedSecretPlaceholder = {
	path: string
	/** 1-based source line, when the parser recorded one. */
	line: number | null
	/**
	 * Secret or integration name the placeholder references (the username
	 * name for a basic pair). Null for a vault reference or a name computed
	 * at runtime.
	 */
	slot: string | null
	location: PlaceholderLocation
}

/**
 * Header that opts one fetch out of body refusal (`headers-only`) or all
 * resolution (`off`). A module that sets it is quoting placeholder syntax on
 * purpose, so its strings are not reported.
 */
const secretResolutionOptOutPattern = /x-kody-secret-resolution/i

function placeholderSlot(placeholder: Placeholder) {
	switch (placeholder.kind) {
		case 'secret':
		case 'integration':
			return placeholder.names[0] ?? null
		case 'vault':
		case 'computed':
			return null
		default: {
			const exhaustive: never = placeholder
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

/**
 * Placeholders in package modules that the fetch gateway will refuse because
 * they provably sit in a URL, query, or body. Unparseable modules are skipped:
 * the bundle check reports them, and a text guess here would block publish on
 * a false positive.
 */
export function findSecretPlaceholdersOutsideHeaders(
	files: Record<string, string>,
): Array<MisplacedSecretPlaceholder> {
	const parsedModules = new Map<string, AstNode | null>()
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		if (!scannableModuleFilePattern.test(path) || testFilePattern.test(path)) {
			continue
		}
		parsedModules.set(path, parseModule(source))
	}
	const moduleConstants = createModuleConstantsReader(parsedModules)
	const findings: Array<MisplacedSecretPlaceholder> = []
	const seen = new Set<string>()
	for (const [path, parsed] of parsedModules) {
		if (!parsed || !files[path]?.includes('{{')) continue
		if (secretResolutionOptOutPattern.test(files[path] ?? '')) continue
		visitModuleStrings(
			parsed,
			moduleConstants(path),
			({ node, text, ancestors }) => {
				const placeholders = findPlaceholders(text)
				if (placeholders.length === 0) return
				const location = literalLocationOutsideHeader(node, text, ancestors)
				if (!location) return
				const line = node.loc?.start?.line ?? null
				for (const placeholder of placeholders) {
					const slot = placeholderSlot(placeholder)
					const key = `${path}\u0000${line}\u0000${slot}\u0000${location}`
					if (seen.has(key)) continue
					seen.add(key)
					findings.push({ path, line, slot, location })
				}
			},
		)
	}
	return findings.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			(left.line ?? 0) - (right.line ?? 0),
	)
}

const locationLabels: Record<PlaceholderLocation, string> = {
	url: 'the request URL',
	body: 'the request body',
	'url or body': 'a query string or form body',
}

export function describeMisplacedSecretPlaceholder(
	finding: MisplacedSecretPlaceholder,
) {
	const where = finding.line == null ? '' : ` line ${finding.line}`
	const what = finding.slot ? `slot "${finding.slot}"` : 'a secret placeholder'
	return `"${finding.path}"${where} puts ${what} in ${locationLabels[finding.location]}`
}

export const misplacedSecretPlaceholderFix =
	"The fetch gateway substitutes a secret only into a request header, so it refuses these requests. Send a credential in the header its kody.credentials slot declares (for example headers: { Authorization: 'Bearer {{secret:apiToken}}' }). A value that is not a credential, such as an account id, belongs in params or package storage, not a secret. To send placeholder text on purpose (a message that quotes the syntax), set the x-kody-secret-resolution: headers-only header on that fetch."
