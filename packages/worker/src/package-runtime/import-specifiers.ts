import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

export type LiteralImportNode = {
	start: number
	end: number
	specifier: string
	kind: 'dynamic' | 'static'
}

export type DynamicImportExpressionNode = {
	start: number
	end: number
	sourceStart: number
	sourceEnd: number
	literalSpecifier: string | null
}

function readLiteralStringNode(
	node: unknown,
): { start: number; end: number; specifier: string } | null {
	if (node == null || typeof node !== 'object') return null
	if (!('type' in node)) return null
	const typedNode = node as {
		type?: string
		value?: unknown
		start?: number
		end?: number
		extra?: { rawValue?: unknown }
	}
	const literalValue =
		typeof typedNode.value === 'string'
			? typedNode.value
			: typeof typedNode.extra?.rawValue === 'string'
				? typedNode.extra.rawValue
				: null
	if (
		(typedNode.type === 'Literal' || typedNode.type === 'StringLiteral') &&
		typeof literalValue === 'string' &&
		typeof typedNode.start === 'number' &&
		typeof typedNode.end === 'number'
	) {
		return {
			start: typedNode.start,
			end: typedNode.end,
			specifier: literalValue,
		}
	}
	return null
}

function hasOnlyTypeSpecifiers(node: ModuleAstNode) {
	const specifiers = (node as { specifiers?: unknown }).specifiers
	if (!Array.isArray(specifiers) || specifiers.length === 0) {
		return false
	}
	return specifiers.every(
		(specifier) =>
			specifier &&
			typeof specifier === 'object' &&
			((specifier as { importKind?: unknown }).importKind === 'type' ||
				(specifier as { exportKind?: unknown }).exportKind === 'type'),
	)
}

function isTypeOnlyImportOrExport(node: ModuleAstNode) {
	if (
		(node as { importKind?: unknown }).importKind === 'type' ||
		(node as { exportKind?: unknown }).exportKind === 'type'
	) {
		return true
	}
	return hasOnlyTypeSpecifiers(node)
}

export function collectLiteralImportNodes(
	source: string,
	options?: { includeTypeOnly?: boolean },
): Array<LiteralImportNode> {
	const nodes: Array<LiteralImportNode> = []

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as ModuleAstNode & {
			source?: { type?: string; value?: unknown; start?: number; end?: number }
		}
		if (
			typedNode.type === 'ImportDeclaration' ||
			typedNode.type === 'ExportAllDeclaration' ||
			typedNode.type === 'ExportNamedDeclaration'
		) {
			if (
				isTypeOnlyImportOrExport(typedNode) &&
				options?.includeTypeOnly !== true
			) {
				return
			}
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push({ ...literalNode, kind: 'static' })
			}
		}
		if (typedNode.type === 'ImportExpression') {
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push({ ...literalNode, kind: 'dynamic' })
			}
		}
		if (
			typedNode.type === 'TSImportType' &&
			options?.includeTypeOnly === true
		) {
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push({ ...literalNode, kind: 'static' })
			}
		}
		for (const value of Object.values(
			typedNode as unknown as Record<string, unknown>,
		)) {
			if (value == null) continue
			if (typeof value === 'object') {
				visit(value)
			}
		}
	}

	try {
		const program = parseModuleSource(source)
		visit(program)
	} catch {
		return []
	}

	return nodes.sort((left, right) => left.start - right.start)
}

const typeOnlyWrapperNodeTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
	'TSNonNullExpression',
])

function unwrapTypeOnlyExpression(node: unknown): unknown {
	let current = node
	while (
		current != null &&
		typeof current === 'object' &&
		typeOnlyWrapperNodeTypes.has(String((current as { type?: unknown }).type))
	) {
		current = (current as { expression?: unknown }).expression
	}
	return current
}

function readStaticSpecifierNode(wrapped: unknown): string | null {
	// `require(('x' as string))` type-strips to `require('x')`, which the
	// bundler resolves, so parentheses and TS assertions must not hide it.
	const node = unwrapTypeOnlyExpression(wrapped)
	const literal = readLiteralStringNode(node)
	if (literal) return literal.specifier
	if (node == null || typeof node !== 'object') return null
	const template = node as {
		type?: string
		expressions?: Array<unknown>
		quasis?: Array<{ value?: { cooked?: unknown } }>
	}
	if (
		template.type === 'TemplateLiteral' &&
		template.expressions?.length === 0 &&
		template.quasis?.length === 1
	) {
		const cooked = template.quasis[0]?.value?.cooked
		return typeof cooked === 'string' ? cooked : null
	}
	return null
}

/**
 * Every statically known specifier the bundler resolves for a module:
 * `import` / `export … from`, `import()` and `require()` with a literal or
 * substitution-free template argument, and TypeScript `import x =
 * require()`. Type-only imports and exports are erased before bundling and
 * are skipped. Returns null when the source does not parse, so callers can
 * fail closed instead of treating unparseable code as import-free.
 */
export function collectBundlerResolvedSpecifiers(
	source: string,
): Array<string> | null {
	let program: unknown
	try {
		program = parseModuleSource(source)
	} catch {
		return null
	}
	const specifiers: Array<string> = []
	const remember = (node: unknown) => {
		const specifier = readStaticSpecifierNode(node)
		if (specifier != null) specifiers.push(specifier)
	}
	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as ModuleAstNode & {
			source?: unknown
			callee?: { type?: string; name?: unknown }
			arguments?: Array<unknown>
			expression?: unknown
		}
		switch (typedNode.type) {
			case 'ImportDeclaration':
			case 'ExportAllDeclaration':
			case 'ExportNamedDeclaration':
				if (!isTypeOnlyImportOrExport(typedNode)) remember(typedNode.source)
				break
			case 'TSImportEqualsDeclaration':
				if ((typedNode as { importKind?: unknown }).importKind === 'type') {
					return
				}
				break
			case 'ImportExpression':
				remember(typedNode.source)
				break
			case 'CallExpression':
				if (
					typedNode.callee?.type === 'Import' ||
					(typedNode.callee?.type === 'Identifier' &&
						typedNode.callee.name === 'require')
				) {
					remember(typedNode.arguments?.[0])
				}
				break
			case 'TSExternalModuleReference':
				remember(typedNode.expression)
				break
			default:
				break
		}
		for (const value of Object.values(
			typedNode as unknown as Record<string, unknown>,
		)) {
			if (value != null && typeof value === 'object') visit(value)
		}
	}
	visit(program)
	return specifiers
}

export function collectLiteralImportSpecifiers(
	source: string,
	options?: { includeTypeOnly?: boolean },
): Array<string> {
	return collectLiteralImportNodes(source, options).map(
		(node) => node.specifier,
	)
}

export function collectDynamicImportExpressionNodes(
	source: string,
): Array<DynamicImportExpressionNode> {
	const nodes: Array<DynamicImportExpressionNode> = []

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as ModuleAstNode & {
			start?: number
			end?: number
			source?: { start?: number; end?: number }
		}
		if (typedNode.type === 'ImportExpression') {
			const sourceNode = typedNode.source
			if (
				typeof typedNode.start === 'number' &&
				typeof typedNode.end === 'number' &&
				typeof sourceNode?.start === 'number' &&
				typeof sourceNode.end === 'number'
			) {
				nodes.push({
					start: typedNode.start,
					end: typedNode.end,
					sourceStart: sourceNode.start,
					sourceEnd: sourceNode.end,
					literalSpecifier:
						readLiteralStringNode(sourceNode)?.specifier ?? null,
				})
			}
		}
		for (const value of Object.values(
			typedNode as unknown as Record<string, unknown>,
		)) {
			if (value == null) continue
			if (typeof value === 'object') {
				visit(value)
			}
		}
	}

	try {
		const program = parseModuleSource(source)
		visit(program)
	} catch {
		return []
	}

	return nodes.sort((left, right) => left.start - right.start)
}

export function isBarePackageImportSpecifier(specifier: string) {
	if (
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		specifier.startsWith('node:') ||
		specifier.startsWith('cloudflare:') ||
		specifier.startsWith('kody:')
	) {
		return false
	}
	return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
}

export function getBarePackageNameFromSpecifier(specifier: string) {
	if (!isBarePackageImportSpecifier(specifier)) {
		return null
	}
	if (specifier.startsWith('@')) {
		const [scope, name] = specifier.split('/', 3)
		if (!scope || !name) return specifier
		return `${scope}/${name}`
	}
	return specifier.split('/', 2)[0] ?? specifier
}
