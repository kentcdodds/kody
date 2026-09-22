/**
 * Keep in lockstep with
 * packages/worker/src/mcp/python-execute/failure-taxonomy.ts.
 * A node test fails when the two classifiers disagree.
 */
export function classifyPythonFailure(input) {
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
