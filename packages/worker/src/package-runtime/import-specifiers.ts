import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

export type LiteralImportNode = {
	start: number
	end: number
	specifier: string
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

export function collectLiteralImportNodes(
	source: string,
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
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push(literalNode)
			}
		}
		if (typedNode.type === 'ImportExpression') {
			const literalNode = readLiteralStringNode(typedNode.source)
			if (literalNode) {
				nodes.push(literalNode)
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

export function collectLiteralImportSpecifiers(source: string): Array<string> {
	return collectLiteralImportNodes(source).map((node) => node.specifier)
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
