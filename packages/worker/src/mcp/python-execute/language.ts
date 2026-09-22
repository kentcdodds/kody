export { pythonExecuteFlagKey } from '#universal/feature-flags/registry.ts'

const pythonExecuteLanguages = ['typescript', 'python'] as const

export type PythonExecuteLanguage = (typeof pythonExecuteLanguages)[number]

export const pythonExecuteFlagOffMessage =
	'Python execute is an experiment. Opt in at /account/experiments, then an operator enables python-execute for experiments_opt_in.'

export const pythonExecuteMissingCodeMessage =
	'Python execute requires code: one module that defines async def main(params) or def main(params).'

export const pythonExecuteInvokeConflictMessage =
	'Python execute runs code. Leave invoke empty and pass a Python module in code.'

export const pythonExecuteLanguageMessage =
	'execute language is typescript or python. Omit language for TypeScript.'

export const pythonExecuteContractMessage =
	'Python execute modules define async def main(params) or def main(params).'

const pythonMainPattern = /(?:async\s+)?def\s+main\s*\(/

export function sourceDefinesPythonMain(source: string) {
	return pythonMainPattern.test(source)
}

export function resolvePythonExecuteLanguage(input: {
	language?: string
	pythonEnabled: boolean
}): PythonExecuteLanguage {
	const language = input.language?.trim() || 'typescript'
	if (language === 'typescript') return 'typescript'
	if (language === 'python') {
		if (!input.pythonEnabled) {
			throw new Error(pythonExecuteFlagOffMessage)
		}
		return 'python'
	}
	throw new Error(pythonExecuteLanguageMessage)
}

/**
 * Python is a sibling of the TypeScript module string. `invoke` stays on the
 * TypeScript path. Flag-off callers keep today's execute contract.
 */
export function resolvePythonExecuteRequest(input: {
	code?: string
	invoke?: string
	language?: string
	pythonEnabled: boolean
}): { language: PythonExecuteLanguage; code?: string } {
	const language = resolvePythonExecuteLanguage(input)
	if (language === 'typescript') {
		return { language, code: input.code }
	}
	if (input.invoke?.trim()) {
		throw new Error(pythonExecuteInvokeConflictMessage)
	}
	const code = input.code ?? ''
	if (!code.trim()) {
		throw new Error(pythonExecuteMissingCodeMessage)
	}
	return { language: 'python', code }
}
