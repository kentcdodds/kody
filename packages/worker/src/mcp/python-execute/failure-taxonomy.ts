/**
 * Failure classes the eval harness records. Agents and the coordinator
 * bucket retries by these names.
 */
export const pythonFailureTaxonomies = [
	'syntax',
	'runtime',
	'capability_misuse',
	'missing_lib',
	'contract',
] as const

export type PythonFailureTaxonomy = (typeof pythonFailureTaxonomies)[number]

export function classifyPythonFailure(input: {
	errorName?: string | null
	message: string
}): PythonFailureTaxonomy {
	const name = input.errorName ?? ''
	const message = input.message
	if (name === 'SyntaxError' || message.includes('SyntaxError')) {
		return 'syntax'
	}
	if (
		name === 'ModuleNotFoundError' ||
		name === 'ImportError' ||
		message.includes('No module named') ||
		message.includes('blocked module:')
	) {
		return 'missing_lib'
	}
	if (
		message.includes('Unknown capability') ||
		message.includes('unknown capability') ||
		message.includes('kody.call args')
	) {
		return 'capability_misuse'
	}
	if (message.includes('def main(params)')) {
		return 'contract'
	}
	return 'runtime'
}
