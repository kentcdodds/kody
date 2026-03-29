import {
	DynamicWorkerExecutor,
	type ExecuteResult,
	type ResolvedProvider,
	ToolDispatcher,
	normalizeCode,
	sanitizeToolName,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import {
	isSecretAuthRequiredMessage,
	parseCapabilityAccessRequiredBatchMessage,
	parseCapabilityAccessRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import {
	buildCodemodeUtilsModuleSource,
	codemodeUtilsModuleSpecifier,
} from '#mcp/tools/codemode-utils.ts'

type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>

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
	const globalOutbound = loopbackExports.CodemodeFetchGateway({
		props: input.gatewayProps,
	})
	return {
		execute(code: string, providersOrFns: Array<ResolvedProvider>) {
			if (codeNeedsModuleRunner(code)) {
				return Promise.resolve({
					result: undefined,
					error:
						'Top-level import or export is not supported in the execute sandbox. Use an async arrow function body and dynamic import() instead (for example: const m = await import("@kody/codemode-utils")).',
					logs: [],
				})
			}
			const modules: Record<string, WorkerLoaderModule | string> = {}
			if (codeReferencesCodemodeUtils(code)) {
				modules[codemodeUtilsModuleSpecifier] = {
					js: buildCodemodeUtilsModuleSource(),
				}
			}
			const mergedModules =
				Object.keys(modules).length > 0 ? modules : undefined
			if (codeReferencesCodemodeUtils(code)) {
				return executeDynamicWithKodyUtilsBridge({
					loader: input.env.LOADER,
					timeoutMs: 90_000,
					globalOutbound,
					modules: mergedModules,
					code,
					providers: providersOrFns,
				})
			}
			const executor = new DynamicWorkerExecutor({
				loader: input.env.LOADER,
				timeout: 90_000,
				globalOutbound,
				modules: mergedModules,
			})
			return executor.execute(code, providersOrFns)
		},
	}
}

function validateExecuteProviders(
	providers: Array<ResolvedProvider>,
): ExecuteResult | null {
	const reservedNames = new Set(['__dispatchers', '__logs'])
	const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
	const seenNames = new Set<string>()
	for (const provider of providers) {
		if (reservedNames.has(provider.name)) {
			return {
				result: undefined,
				error: `Provider name "${provider.name}" is reserved`,
			}
		}
		if (!validIdentifier.test(provider.name)) {
			return {
				result: undefined,
				error: `Provider name "${provider.name}" is not a valid JavaScript identifier`,
			}
		}
		if (seenNames.has(provider.name)) {
			return {
				result: undefined,
				error: `Duplicate provider name "${provider.name}"`,
			}
		}
		seenNames.add(provider.name)
	}
	return null
}

function buildKodyUtilsProviderSetupLines(
	providers: Array<ResolvedProvider>,
): Array<string> {
	const lines: Array<string> = ['    const __kodyProviders = {};']
	for (const p of providers) {
		if (p.positionalArgs) {
			lines.push(`    const ${p.name} = new Proxy({}, {
      get: (_, toolName) => async (...args) => {
        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args));
        const data = JSON.parse(resJson);
        if (data.error) throw new Error(data.error);
        return data.result;
      }
    });`)
		} else {
			lines.push(`    const ${p.name} = new Proxy({}, {
      get: (_, toolName) => async (args) => {
        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args ?? {}));
        const data = JSON.parse(resJson);
        if (data.error) throw new Error(data.error);
        return data.result;
      }
    });`)
		}
		lines.push(`    __kodyProviders.${p.name} = ${p.name};`)
	}
	lines.push('    globalThis.__kodyProviders = __kodyProviders;')
	return lines
}

async function executeDynamicWithKodyUtilsBridge(input: {
	loader: WorkerLoader
	timeoutMs: number
	globalOutbound: Fetcher
	modules?: Record<string, WorkerLoaderModule | string>
	code: string
	providers: Array<ResolvedProvider>
}): Promise<ExecuteResult> {
	const validationError = validateExecuteProviders(input.providers)
	if (validationError) return validationError

	const normalized = normalizeCode(input.code)
	const timeoutMs = input.timeoutMs
	const executorModule = [
		'import { WorkerEntrypoint } from "cloudflare:workers";',
		'',
		'export default class CodeExecutor extends WorkerEntrypoint {',
		'  async evaluate(__dispatchers = {}) {',
		'    const __logs = [];',
		'    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
		'    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
		'    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
		...buildKodyUtilsProviderSetupLines(input.providers),
		'    try {',
		'      const result = await Promise.race([',
		'        (',
		normalized,
		')(),',
		`        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
		'      ]);',
		'      return { result, logs: __logs };',
		'    } catch (err) {',
		'      return { result: undefined, error: err instanceof Error ? err.message : String(err), logs: __logs };',
		'    } finally {',
		'      delete globalThis.__kodyProviders;',
		'    }',
		'  }',
		'}',
	].join('\n')

	const dispatchers = Object.create(null) as Record<string, ToolDispatcher>
	for (const provider of input.providers) {
		const sanitizedFns = Object.fromEntries(
			Object.entries(provider.fns).map(([name, fn]) => [sanitizeToolName(name), fn]),
		)
		dispatchers[provider.name] = new ToolDispatcher(
			sanitizedFns,
			provider.positionalArgs,
		)
	}

	type CodeExecutorEntrypoint = {
		evaluate(dispatchers: Record<string, ToolDispatcher>): Promise<ExecuteResult>
	}

	const entrypoint = input.loader
		.get(`codemode-${crypto.randomUUID()}`, () => ({
			compatibilityDate: '2025-06-01',
			compatibilityFlags: ['nodejs_compat'],
			mainModule: 'executor.js',
			modules: {
				...(input.modules ?? {}),
				'executor.js': executorModule,
			},
			globalOutbound: input.globalOutbound,
		}))
		.getEntrypoint() as unknown as CodeExecutorEntrypoint

	const response = await entrypoint.evaluate(dispatchers)
	if (response.error) {
		return {
			result: undefined,
			error: response.error,
			logs: response.logs,
		}
	}
	return {
		result: response.result,
		logs: response.logs ?? [],
	}
}

function codeReferencesCodemodeUtils(code: string) {
	return code.includes(codemodeUtilsModuleSpecifier)
}

function codeNeedsModuleRunner(code: string) {
	const trimmed = code.trim()
	return (
		/^\s*import\s/m.test(trimmed) || /^\s*export\s/m.test(trimmed)
	)
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
