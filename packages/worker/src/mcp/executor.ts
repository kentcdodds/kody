import {
	DynamicWorkerExecutor,
	normalizeCode,
	type ExecuteResult,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

export function createExecuteExecutor(input: {
	env: Env
	exports?: WorkerLoopbackExports
	gatewayProps: FetchGatewayProps
}) {
	const loopbackExports = input.exports ?? workerExports
	if (!loopbackExports?.CodemodeFetchGateway) {
		throw new Error(
			'CodemodeFetchGateway export is required for execute-time fetch.',
		)
	}
	return new DynamicWorkerExecutor({
		loader: input.env.LOADER,
		timeout: 90_000,
		globalOutbound: loopbackExports.CodemodeFetchGateway({
			props: input.gatewayProps,
		}),
	})
}

export function wrapExecuteCode(code: string) {
	const normalized = normalizeCode(code)
	return normalizeCode(`async () => {
  const listSecrets = async (options = {}) => {
    const result = await codemode.secret_list(options);
    return Array.isArray(result?.secrets) ? result.secrets : [];
  };
  const secrets = {
    list: listSecrets,
  };
  const userCode = (${normalized});
  return await userCode();
}`)
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
