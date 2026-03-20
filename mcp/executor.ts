import {
	DynamicWorkerExecutor,
	normalizeCode,
	type ExecuteResult,
} from '@cloudflare/codemode'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

export function createExecuteExecutor(env: Env) {
	return new DynamicWorkerExecutor({
		loader: env.LOADER,
		timeout: 90_000,
	})
}

export function wrapExecuteCode(code: string) {
	return normalizeCode(code)
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) return `Error: ${result.error}`
	return truncateExecutionResult(result.result)
}

function truncateExecutionResult(value: unknown) {
	const text =
		typeof value === 'string'
			? value
			: (JSON.stringify(value, null, 2) ?? 'undefined')

	if (text.length <= maxChars) return text

	return `${text.slice(0, maxChars)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
		text.length / charsPerToken,
	).toLocaleString()} tokens (limit: ${maxTokens.toLocaleString()}). Use more specific queries to reduce response size.`
}
