import { DynamicWorkerExecutor, type ExecuteResult } from '@cloudflare/codemode'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { exports as workerExports } from 'cloudflare:workers'
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	isSecretAuthRequiredMessage,
	parseCapabilityAccessRequiredBatchMessage,
	parseCapabilityAccessRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
} from '#mcp/secrets/errors.ts'

type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

export function createExecuteExecutor(input: {
	env: Env
	exports?: WorkerLoopbackExports
	gatewayProps: FetchGatewayProps
	modules?: WorkerLoaderModules
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
		modules: input.modules as unknown as Record<string, string> | undefined,
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
			kind: 'host_approval_required_batch'
			message: string
			nextStep: string
			missingApprovals: Array<{
				secretName: string
				host: string
				approvalUrl: string
			}>
			suggestedAction: {
				type: 'approve_secret_host'
			}
	  }
	| {
			kind: 'secret_capability_access_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			capabilityName: string
			approvalUrl: string | null
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_capabilities'
			}
	  }
	| {
			kind: 'secret_capability_access_required_batch'
			message: string
			nextStep: string
			missingApprovals: Array<{
				secretName: string
				capabilityName: string
				approvalUrl: string
			}>
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_capabilities'
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

	const hostApprovalDetails = parseHostApprovalRequiredMessage(message)
	if (hostApprovalDetails) {
		return {
			kind: 'host_approval_required',
			message,
			nextStep:
				'Ask the user whether they want to approve this host in the account web UI, then retry after approval.',
			approvalUrl: extractFirstUrl(message),
			host: hostApprovalDetails.host,
			secretNames: [hostApprovalDetails.secretName],
			suggestedAction: {
				type: 'approve_secret_host',
			},
		}
	}

	const hostApprovalBatch = parseHostApprovalRequiredBatchMessage(message)
	if (hostApprovalBatch) {
		return {
			kind: 'host_approval_required_batch',
			message,
			nextStep:
				'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
			missingApprovals: hostApprovalBatch,
			suggestedAction: {
				type: 'approve_secret_host',
			},
		}
	}

	const capabilityAccessBatch =
		parseCapabilityAccessRequiredBatchMessage(message)
	if (capabilityAccessBatch) {
		return {
			kind: 'secret_capability_access_required_batch',
			message,
			nextStep:
				'Ask the user whether they want to approve these capabilities for the listed secrets in the account secrets UI, then retry after approval.',
			missingApprovals: capabilityAccessBatch,
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_capabilities',
			},
		}
	}

	const capabilityAccessDetails = parseCapabilityAccessRequiredMessage(message)
	if (capabilityAccessDetails) {
		return {
			kind: 'secret_capability_access_required',
			message,
			nextStep:
				"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
			secretNames: [capabilityAccessDetails.secretName],
			capabilityName: capabilityAccessDetails.capabilityName,
			approvalUrl: extractFirstUrl(message),
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_capabilities',
			},
		}
	}

	const missingSecretDetails = parseMissingSecretMessage(message)
	if (missingSecretDetails) {
		return {
			kind: 'secret_required',
			message,
			nextStep:
				'Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
			secretNames: [missingSecretDetails.secretName],
			suggestedAction: {
				type: 'open_generated_ui',
				reason: 'collect_secret',
			},
		}
	}

	if (isSecretAuthRequiredMessage(message)) {
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

export function extractRawContent(value: unknown): Array<ContentBlock> | null {
	if (
		typeof value === 'object' &&
		value !== null &&
		'__mcpContent' in value &&
		Array.isArray((value as { __mcpContent: unknown }).__mcpContent)
	) {
		return (value as { __mcpContent: Array<ContentBlock> }).__mcpContent
	}
	return null
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
