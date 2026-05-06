import { parse } from '@babel/parser'

export type ModuleAstNode = {
	type: string
	[key: string]: unknown
}

export function stripCodeFences(code: string): string {
	const match = code.match(
		/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/,
	)
	return match?.[1] ?? code
}

export function parseModuleSource(source: string) {
	return parse(source, {
		sourceType: 'module',
		plugins: ['typescript', 'jsx'],
		createImportExpressions: true,
	})
}

function getProgramBody(parsed: ModuleAstNode) {
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	return Array.isArray(body) ? body : []
}

function getNodeName(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const candidate = node as { name?: unknown; value?: unknown }
	if (typeof candidate.name === 'string') return candidate.name
	if (typeof candidate.value === 'string') return candidate.value
	return null
}

export function hasTopLevelModuleSyntax(source: string) {
	if (!source) return false
	try {
		const body = getProgramBody(
			parseModuleSource(source) as unknown as ModuleAstNode,
		)
		return body.some(
			(statement) =>
				statement?.type === 'ImportDeclaration' ||
				statement?.type?.startsWith('Export') === true,
		)
	} catch {
		return false
	}
}

export function hasTopLevelDefaultExport(source: string) {
	if (!source) return false
	try {
		const body = getProgramBody(
			parseModuleSource(source) as unknown as ModuleAstNode,
		)
		return body.some((statement) => {
			if (statement.type === 'ExportDefaultDeclaration') return true
			if (statement.type !== 'ExportNamedDeclaration') return false
			const specifiers = statement.specifiers
			if (!Array.isArray(specifiers)) return false
			return specifiers.some(
				(specifier) =>
					getNodeName((specifier as ModuleAstNode).exported) === 'default',
			)
		})
	} catch {
		return false
	}
}
