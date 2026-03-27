import { DynamicWorkerExecutor, type ExecuteResult } from '@cloudflare/codemode'
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

export type ExecutionErrorDetails =
	| {
			kind: 'host_approval_required'
			message: string
			nextStep: string
			approvalUrl: string | null
			host: string | null
			secretNames: Array<string>
			suggestedAction: {
				type: 'approve_secret_host'
			}
	  }
	| {
			kind: 'secret_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			suggestedAction: {
				type: 'open_generated_ui'
				reason: 'collect_secret'
			}
	  }
	| {
			kind: 'auth_required'
			message: string
			nextStep: string
			suggestedAction: {
				type: 'sign_in'
			}
	  }

export function getExecutionErrorDetails(
	error: unknown,
): ExecutionErrorDetails | null {
	const message = stringifyExecutionError(error)

	const hostApprovalMatch = message.match(
		/^Secret "([^"]+)" is not allowed for host "([^"]+)"/,
	)
	if (hostApprovalMatch) {
		return {
			kind: 'host_approval_required',
			message,
			nextStep:
				'Ask the user whether they want to approve this host in the account web UI, then retry after approval.',
			approvalUrl: extractFirstUrl(message),
			host: hostApprovalMatch[2] ?? null,
			secretNames: [hostApprovalMatch[1] ?? ''].filter(Boolean),
			suggestedAction: {
				type: 'approve_secret_host',
			},
		}
	}

	const missingSecretMatch = message.match(/^Secret "([^"]+)" was not found\./)
	if (missingSecretMatch) {
		return {
			kind: 'secret_required',
			message,
			nextStep:
				'Open a generated UI so the user can provide and save this secret, then retry the workflow.',
			secretNames: [missingSecretMatch[1] ?? ''].filter(Boolean),
			suggestedAction: {
				type: 'open_generated_ui',
				reason: 'collect_secret',
			},
		}
	}

	if (
		message ===
		'Network requests that use secret placeholders require an authenticated user.'
	) {
		return {
			kind: 'auth_required',
			message,
			nextStep: 'Ask the user to sign in to Kody, then retry the request.',
			suggestedAction: {
				type: 'sign_in',
			},
		}
	}

	return null
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) {
		const errorText = stringifyExecutionError(result.error)
		const details = getExecutionErrorDetails(result.error)
		if (!details) return `Error: ${errorText}`
		return `Error: ${errorText}\n\nNext step: ${details.nextStep}`
	}
	return truncateExecutionResult(result.result)
}

function stringifyExecutionError(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function extractFirstUrl(message: string) {
	for (const part of message.split(/\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			return part.replace(/[),.;]+$/, '')
		}
	}
	return null
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
