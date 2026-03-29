import {
	type ExecuteResult,
	type ResolvedProvider,
	ToolDispatcher,
	normalizeCode,
	sanitizeToolName,
} from '@cloudflare/codemode'
import * as acorn from 'acorn'
import { exports as workerExports } from 'cloudflare:workers'
type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>
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
	return {
		execute(code: string, providersOrFns: Array<ResolvedProvider>) {
			return executeWithWorkerLoader({
				loader: input.env.LOADER,
				timeoutMs: 90_000,
				code,
				providers: providersOrFns,
				globalOutbound: loopbackExports.CodemodeFetchGateway({
					props: input.gatewayProps,
				}),
			})
		},
	}
}

function buildProviderProxySource(provider: ResolvedProvider) {
	if (provider.positionalArgs) {
		return `new Proxy({}, {
      get: (_, toolName) => async (...args) => {
        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args));
        const data = JSON.parse(resJson);
        if (data.error) throw new Error(data.error);
        return data.result;
      }
    })`
	}
	return `new Proxy({}, {
      get: (_, toolName) => async (args) => {
        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args ?? {}));
        const data = JSON.parse(resJson);
        if (data.error) throw new Error(data.error);
        return data.result;
      }
    })`
}

function buildUserEntryModuleSource(code: string) {
	const trimmed = code.trim()
	const looksLikeModule =
		/^\s*import\s/m.test(trimmed) || /^\s*export\s/m.test(trimmed)
	if (looksLikeModule) {
		return wrapImportedExecuteCode(trimmed)
	}
	return `export default ${normalizeCode(code)};`
}

function wrapImportedExecuteCode(source: string) {
	try {
		const parsed = acorn.parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			allowReturnOutsideFunction: true,
		})
		if (
			parsed.body.some((node) => node.type === 'ExportDefaultDeclaration') ||
			parsed.body.some(
				(node) =>
					node.type === 'ExportNamedDeclaration' ||
					node.type === 'ExportAllDeclaration',
			)
		) {
			return source
		}
		const importNodes = parsed.body.filter(
			(node) => node.type === 'ImportDeclaration',
		)
		const bodyNodes = parsed.body.filter(
			(node) => node.type !== 'ImportDeclaration',
		)
		const imports = importNodes
			.map((node) => source.slice(node.start, node.end))
			.join('\n')
		const body = bodyNodes
			.map((node, index) => {
				if (
					index === bodyNodes.length - 1 &&
					node.type === 'ExpressionStatement' &&
					!node.directive
				) {
					return `return ${source.slice(node.start, node.end)}`
				}
				return source.slice(node.start, node.end)
			})
			.join('\n')
		return [
			imports,
			imports.length > 0 ? '' : undefined,
			'export default async () => {',
			body,
			'}',
		]
			.filter((part) => typeof part === 'string')
			.join('\n')
	} catch {
		return source
	}
}

function buildUserCodeRunnerModuleSource() {
	return [
		'import * as __kodyUserModule from "user-entry.js";',
		'',
		'export async function __kodyRunUserCode() {',
		'  const __kodyExecuteFunction = __kodyUserModule.default;',
		'  if (typeof __kodyExecuteFunction !== "function") {',
		'    throw new Error("Execute code must evaluate to an async function.");',
		'  }',
		'  return await __kodyExecuteFunction();',
		'}',
	].join('\n')
}

async function executeWithWorkerLoader(input: {
	loader: WorkerLoader
	timeoutMs: number
	code: string
	providers: Array<ResolvedProvider>
	globalOutbound: Fetcher
}): Promise<ExecuteResult> {
	const reservedNames = new Set(['__dispatchers', '__logs', '__providers'])
	const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
	const seenNames = new Set<string>()
	for (const provider of input.providers) {
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

	const executorModuleSource = [
		'import { WorkerEntrypoint } from "cloudflare:workers";',
		'import { __kodyRunUserCode } from "user-code.js";',
		'',
		'export default class CodeExecutor extends WorkerEntrypoint {',
		'  async evaluate(__dispatchers = {}) {',
		'    const __logs = [];',
		'    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
		'    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
		'    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
		'    const __providers = {};',
		...input.providers.flatMap((provider) => [
			`    const ${provider.name} = ${buildProviderProxySource(provider)};`,
			`    __providers.${provider.name} = ${provider.name};`,
		]),
		'    globalThis.__kodyProviders = __providers;',
		'    try {',
		'      const result = await Promise.race([',
		'        __kodyRunUserCode(),',
		`        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${input.timeoutMs}))`,
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

	const dispatchers = {} as Record<string, ToolDispatcher>
	for (const provider of input.providers) {
		const sanitizedFns = Object.fromEntries(
			Object.entries(provider.fns).map(([name, fn]) => [
				sanitizeToolName(name),
				fn,
			]),
		)
		dispatchers[provider.name] = new ToolDispatcher(
			sanitizedFns,
			provider.positionalArgs,
		)
	}

	const entrypoint = input.loader
		.get(`codemode-${crypto.randomUUID()}`, () => ({
			compatibilityDate: '2025-06-01',
			compatibilityFlags: ['nodejs_compat'],
			mainModule: 'executor.js',
			modules: {
				[`${codemodeUtilsModuleSpecifier}`]: {
					js: buildCodemodeUtilsModuleSource(),
				},
				'user-entry.js': buildUserEntryModuleSource(input.code),
				'user-code.js': buildUserCodeRunnerModuleSource(),
				'executor.js': executorModuleSource,
			},
			globalOutbound: input.globalOutbound,
		}))
		.getEntrypoint()

	const response = (await entrypoint.evaluate(dispatchers)) as ExecuteResult
	if (response.error) {
		return {
			result: undefined,
			error: response.error,
			logs: response.logs,
		}
	}
	return {
		result: response.result,
		logs: response.logs,
	}
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
