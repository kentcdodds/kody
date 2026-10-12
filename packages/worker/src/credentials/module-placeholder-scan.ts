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

export type PlaceholderMatchKind =
	| 'secret'
	| 'secret-basic'
	| 'integration-token'
	| 'vault'
	| 'computed'

const placeholderMatchKindByOpener: Record<
	string,
	Exclude<PlaceholderMatchKind, 'computed'>
> = {
	'secret:': 'secret',
	'secret-basic:': 'secret-basic',
	'secret/': 'vault',
	'integration-token:': 'integration-token',
}

export type PlaceholderMatch = {
	kind: PlaceholderMatchKind
	/** Names the placeholder reads; empty for vault and computed. */
	names: Array<string>
	/** Literal `|scope=` suffix, or null when it has none. */
	scope: string | null
	start: number
	end: number
}

/**
 * Every placeholder in `text` with its position. Prose that names nothing is
 * skipped; anything else that opens a placeholder but does not complete one
 * is `computed`.
 */
export function findPlaceholderMatches(text: string) {
	const matches: Array<PlaceholderMatch> = []
	for (const match of text.matchAll(placeholderOpenerPattern)) {
		const opener = match[1]!
		const complete = completePlaceholderPatterns[opener]!
		complete.pattern.lastIndex = match.index
		const found = complete.pattern.exec(text)
		if (found) {
			matches.push({
				kind: placeholderMatchKindByOpener[opener]!,
				names: complete.kind ? found.slice(1) : [],
				scope: /\|scope=([a-z]+)\}\}$/.exec(found[0])?.[1] ?? null,
				start: match.index,
				end: match.index + found[0].length,
			})
			continue
		}
		prosePlaceholderPattern.lastIndex = match.index
		if (prosePlaceholderPattern.test(text)) continue
		matches.push({
			kind: 'computed',
			names: [],
			scope: null,
			start: match.index,
			end: match.index + opener.length + 2,
		})
	}
	return matches
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
	params?: Array<AstNode>
	body?: AstNode | Array<AstNode>
	elements?: Array<AstNode | null | undefined>
	argument?: AstNode
	param?: AstNode
	kind?: unknown
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

/**
 * Names bound in an enclosing function, catch, or block that shadow a
 * module-level constant for `node`'s ancestors.
 */
export function shadowedConstantNames(ancestors: ReadonlyArray<AstNode>) {
	const names = new Set<string>()
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (ancestor.type === 'Program') break
		if (
			ancestor.type === 'FunctionDeclaration' ||
			ancestor.type === 'FunctionExpression' ||
			ancestor.type === 'ArrowFunctionExpression'
		) {
			for (const param of ancestor.params ?? []) {
				collectBoundNames(param, names)
			}
		}
		if (ancestor.type === 'CatchClause' && ancestor.param) {
			collectBoundNames(ancestor.param, names)
		}
		if (ancestor.type === 'BlockStatement' && Array.isArray(ancestor.body)) {
			for (const statement of ancestor.body) {
				if (statement.type !== 'VariableDeclaration') continue
				for (const declarator of statement.declarations ?? []) {
					collectBoundNames(declarator.id, names)
				}
			}
		}
	}
	return names
}

function collectBoundNames(
	pattern: AstNode | null | undefined,
	names: Set<string>,
) {
	if (!pattern) return
	switch (pattern.type) {
		case 'Identifier': {
			const name = getNodeName(pattern)
			if (name) names.add(name)
			return
		}
		case 'AssignmentPattern':
			collectBoundNames(pattern.left, names)
			return
		case 'RestElement':
			collectBoundNames(pattern.argument, names)
			return
		case 'ObjectPattern':
			for (const property of pattern.properties ?? []) {
				if (property.type === 'RestElement') {
					collectBoundNames(property.argument, names)
				} else if (property.type === 'ObjectProperty') {
					collectBoundNames(property.value as AstNode, names)
				}
			}
			return
		case 'ArrayPattern':
			for (const element of pattern.elements ?? []) {
				collectBoundNames(element, names)
			}
			return
		default:
			return
	}
}

/** Module constants with locally shadowed names removed. */
export function constantsWithoutShadows(
	constants: ReadonlyMap<string, string>,
	ancestors: ReadonlyArray<AstNode>,
) {
	const shadowed = shadowedConstantNames(ancestors)
	if (shadowed.size === 0) return constants
	const filtered = new Map<string, string>()
	for (const [name, value] of constants) {
		if (!shadowed.has(name)) filtered.set(name, value)
	}
	return filtered
}

/** `src/a.ts` + `../lib/names.js` → `lib/names.ts` when that file exists. */
export function resolveRelativeModulePath(
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizePackageEntryPath(value: string) {
	return value.replace(/^\.\//, '')
}

/** Manifest entry strings from `exports` / `main` / `module` / `browser`. */
function collectManifestEntryPaths(manifestSource: string | undefined) {
	if (manifestSource == null) return [] as Array<string>
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return []
	}
	if (!isPlainObject(parsed)) return []
	const entries: Array<string> = []
	const add = (value: unknown) => {
		if (typeof value === 'string') {
			entries.push(normalizePackageEntryPath(value))
			return
		}
		if (Array.isArray(value)) {
			for (const item of value) add(item)
			return
		}
		if (isPlainObject(value)) {
			for (const item of Object.values(value)) add(item)
		}
	}
	add(parsed.exports)
	add(parsed.main)
	add(parsed.module)
	add(parsed.browser)
	return entries
}

function relativeModuleSpecifiers(parsed: AstNode) {
	const specifiers: Array<string> = []
	for (const node of parsed.program?.body ?? []) {
		if (
			node.type !== 'ImportDeclaration' &&
			node.type !== 'ExportNamedDeclaration' &&
			node.type !== 'ExportAllDeclaration'
		) {
			continue
		}
		const source = getNodeName(node.source)
		if (source?.startsWith('./') || source?.startsWith('../')) {
			specifiers.push(source)
		}
	}
	return specifiers
}

/**
 * Modules the package can run: every scannable file except test-named ones,
 * plus test-named files reachable from package.json runtime entries.
 */
export function listScannableModulePaths(files: Record<string, string>) {
	const modulePaths = Object.keys(files).filter(
		(path) =>
			typeof files[path] === 'string' && scannableModuleFilePattern.test(path),
	)
	const modulePathSet = new Set(modulePaths)
	const resolveEntry = (entry: string) => {
		if (modulePathSet.has(entry)) return entry
		return (
			resolveRelativeModulePath('package.json', `./${entry}`, modulePathSet) ??
			null
		)
	}
	const runtime = new Set<string>()
	const queue = collectManifestEntryPaths(files[packageManifestPath]).flatMap(
		(entry) => {
			const resolved = resolveEntry(entry)
			return resolved ? [resolved] : []
		},
	)
	while (queue.length > 0) {
		const path = queue.pop()!
		if (runtime.has(path)) continue
		runtime.add(path)
		const parsed = parseModule(files[path]!)
		if (!parsed) continue
		for (const specifier of relativeModuleSpecifiers(parsed)) {
			const target = resolveRelativeModulePath(path, specifier, modulePathSet)
			if (target) queue.push(target)
		}
	}
	return modulePaths.filter(
		(path) => !testFilePattern.test(path) || runtime.has(path),
	)
}

const packageManifestPath = 'package.json'

type ModuleImport = {
	local: string
	imported: string
	target: string
}

type ModuleBindingInfo = {
	body: Array<AstNode>
	imports: Array<ModuleImport>
}

function readModuleBindingInfo(
	path: string,
	parsed: AstNode | null | undefined,
	modulePaths: ReadonlySet<string>,
): ModuleBindingInfo {
	const body = parsed?.program?.body ?? []
	const imports: Array<ModuleImport> = []
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		const source = getNodeName(node.source)
		const target = source
			? resolveRelativeModulePath(path, source, modulePaths)
			: null
		if (!target) continue
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported = getNodeName(specifier.imported)
			const local = getNodeName(specifier.local)
			if (imported && local) imports.push({ local, imported, target })
		}
	}
	return { body, imports }
}

function resolveModuleBindings(
	info: ModuleBindingInfo,
	importedConstants: ReadonlyMap<string, string>,
) {
	const constants = new Map(importedConstants)
	const exportedNames = new Map<string, string>()
	for (const node of info.body) {
		const declaration =
			node.type === 'ExportNamedDeclaration' ? node.declaration : node
		if (
			declaration?.type === 'VariableDeclaration' &&
			declaration.kind === 'const'
		) {
			for (const declarator of declaration.declarations ?? []) {
				if (declarator.id?.type !== 'Identifier') continue
				const name = getNodeName(declarator.id)
				const value = resolveStringExpression(declarator.init, constants)
				if (!name || value == null) continue
				constants.set(name, value)
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
	const exported = new Map<string, string>()
	for (const [exportedName, local] of exportedNames) {
		const value = constants.get(local)
		if (value != null) exported.set(exportedName, value)
	}
	return { constants, exported }
}

/**
 * Top-level `const NAME = <string>` bindings of each module, plus names
 * imported from relative modules that export one. Import cycles iterate to a
 * fixed point so order does not change the result. Inner scopes that shadow a
 * constant are filtered at each use via {@link constantsWithoutShadows}.
 */
export function createModuleConstantsReader(
	parsedModules: ReadonlyMap<string, AstNode | null>,
) {
	const modulePaths = new Set(parsedModules.keys())
	const infos = new Map<string, ModuleBindingInfo>()
	for (const [path, parsed] of parsedModules) {
		infos.set(path, readModuleBindingInfo(path, parsed, modulePaths))
	}
	const constantsByPath = new Map<string, Map<string, string>>()
	const exportedByPath = new Map<string, Map<string, string>>()
	for (const [path, info] of infos) {
		const resolved = resolveModuleBindings(info, new Map())
		constantsByPath.set(path, resolved.constants)
		exportedByPath.set(path, resolved.exported)
	}
	let changed = true
	while (changed) {
		changed = false
		for (const [path, info] of infos) {
			const importedConstants = new Map<string, string>()
			for (const { local, imported, target } of info.imports) {
				const value = exportedByPath.get(target)?.get(imported)
				if (value != null) importedConstants.set(local, value)
			}
			const resolved = resolveModuleBindings(info, importedConstants)
			const previousConstants = constantsByPath.get(path)!
			const previousExported = exportedByPath.get(path)!
			if (
				!mapsEqual(previousConstants, resolved.constants) ||
				!mapsEqual(previousExported, resolved.exported)
			) {
				changed = true
			}
			constantsByPath.set(path, resolved.constants)
			exportedByPath.set(path, resolved.exported)
		}
	}
	return (path: string) => constantsByPath.get(path) ?? new Map()
}

function mapsEqual(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
) {
	if (left.size !== right.size) return false
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false
	}
	return true
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
