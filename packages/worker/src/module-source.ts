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
	})
}

export function hasTopLevelModuleSyntax(code: string) {
	const source = stripCodeFences(code.trim())
	if (!source) return false
	try {
		const parsed = parseModuleSource(source) as {
			body?: Array<{ type?: string }>
			program?: { body?: Array<{ type?: string }> }
		}
		const body = parsed.program?.body ?? parsed.body ?? []
		return body.some(
			(statement) =>
				statement?.type === 'ImportDeclaration' ||
				statement?.type?.startsWith('Export') === true,
		)
	} catch {
		return false
	}
}
