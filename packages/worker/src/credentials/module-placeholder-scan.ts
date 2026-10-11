/**
 * Reads credential placeholders and names out of package module source: the
 * placeholder shapes, an AST walk, and the string constants a name can be
 * built from.
 */
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

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

type Placeholder =
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

export function parseModule(source: string) {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}
