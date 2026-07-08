import {
	normalizeCode,
	sanitizeToolName,
	ToolDispatcher,
	type ExecuteResult,
	type ResolvedProvider,
} from '@cloudflare/codemode'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { exports as workerExports } from 'cloudflare:workers'
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import { recordUsage, type UsageEnv } from '#worker/usage/record-usage.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	isSecretAuthRequiredMessage,
	parseCapabilityAccessRequiredBatchMessage,
	parseCapabilityAccessRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
	parsePackageAccessRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
} from '#mcp/secrets/errors.ts'
import {
	isEntitlementLimitError,
	parseEntitlementLimitMessage,
	type EntitlementLimitErrorDetails,
} from '#worker/entitlements/errors.ts'
import {
	type KodyMcpServerMetadata,
	type KodyRemoteConnectorMetadata,
	type KodyResolvedProvider,
} from '#mcp/kody-remote-types.ts'
import {
	assertGeneratedExecutorSourceIsBundleSafe,
	kodyRemoteProxyFactorySource,
} from '#mcp/kody-remote-proxy-source.ts'

type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>

export const defaultExecutionResponseLimitBytes = 102_400
const maxSupportedExecutorTimeoutMs = 2_147_483_647
const dynamicWorkerCompatibilityDate = '2025-06-01'
const dynamicWorkerCompatibilityFlags = ['nodejs_compat'] as const
const dynamicWorkerMainModule = 'executor.js'
const dynamicWorkerIdPrefix = 'kody-'
const dynamicWorkerCacheKeyVersion = 2
const reservedProviderNames = new Set(['__dispatchers', '__logs'])
const validProviderNamePattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const javascriptReservedWords = new Set([
	'arguments',
	'async',
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'implements',
	'import',
	'in',
	'interface',
	'instanceof',
	'let',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'static',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield',
	'eval',
])

type DynamicWorkerExecutorInput = {
	loader: Env['LOADER']
	timeout: number
	globalOutbound: Fetcher | null
	modules?: WorkerLoaderModules
	gatewayProps: FetchGatewayProps
	appCommitSha?: string | null
	usageEnv: UsageEnv
}

type DynamicWorkerExecutorOptions = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
	mainModule: string
	modules: WorkerLoaderModules
	globalOutbound: Fetcher | null
}

type DynamicWorkerEntrypoint = {
	evaluate(dispatchers: Record<string, ToolDispatcher>): Promise<{
		result: unknown
		error?: string
		logs?: Array<string>
	}>
}

export function createKodyRemoteProxy(input: {
	remoteConnectors: Array<
		Pick<KodyRemoteConnectorMetadata, 'name' | 'status' | 'capabilities'>
	>
	callTool: (dispatchName: string, args: unknown) => Promise<unknown>
	entityLabel?: string
	shortEntityLabel?: string
	capabilityLabel?: string
}) {
	const entityLabel = input.entityLabel ?? 'remote connector'
	const shortEntityLabel = input.shortEntityLabel ?? 'connector'
	const capabilityLabel = input.capabilityLabel ?? 'remote capability'
	const connectors = Object.fromEntries(
		input.remoteConnectors.map((connector) => [
			connector.name,
			{
				...connector,
				capabilitiesByName: Object.fromEntries(
					connector.capabilities.map((capability) => [
						capability.name,
						capability,
					]),
				),
			},
		]),
	)
	const formatNames = (names: Array<string>) =>
		names.length > 0
			? names.map((name) => JSON.stringify(name)).join(', ')
			: 'none'

	return new Proxy(
		{},
		{
			get(_target, connectorName) {
				if (typeof connectorName === 'symbol' || connectorName === 'then') {
					return undefined
				}
				const normalizedConnectorName = String(connectorName)
				const connector = connectors[normalizedConnectorName]
				if (!connector) {
					throw new Error(
						`Unknown ${entityLabel} "${normalizedConnectorName}". Available ${entityLabel}s: ${formatNames(Object.keys(connectors))}.`,
					)
				}
				return new Proxy(
					{},
					{
						get(_connectorTarget, capabilityName) {
							if (
								typeof capabilityName === 'symbol' ||
								capabilityName === 'then'
							) {
								return undefined
							}
							const normalizedCapabilityName = String(capabilityName)
							if (
								!connector.status.connected ||
								connector.status.toolCount === 0
							) {
								throw new Error(connector.status.unavailableMessage)
							}
							const capability =
								connector.capabilitiesByName[normalizedCapabilityName]
							if (!capability) {
								throw new Error(
									`Unknown ${capabilityLabel} "${normalizedCapabilityName}" for ${shortEntityLabel} "${normalizedConnectorName}". Available capabilities: ${formatNames(connector.capabilities.map((entry) => entry.name))}.`,
								)
							}
							return async (args: unknown) =>
								await input.callTool(capability.dispatchName, args)
						},
					},
				)
			},
		},
	)
}

export function createExecuteExecutor(input: {
	env: Env
	exports?: WorkerLoopbackExports
	gatewayProps: FetchGatewayProps
	modules?: WorkerLoaderModules
	timeoutMs?: number | null
}) {
	const loopbackExports = input.exports ?? workerExports
	if (!loopbackExports?.KodyFetchGateway) {
		throw new Error(
			'KodyFetchGateway export is required for execute-time fetch.',
		)
	}
	const timeout =
		input.timeoutMs === null
			? maxSupportedExecutorTimeoutMs
			: (input.timeoutMs ?? 90_000)
	return createStableDynamicWorkerExecutor({
		loader: input.env.LOADER,
		timeout,
		globalOutbound: loopbackExports.KodyFetchGateway({
			props: input.gatewayProps,
		}),
		modules: input.modules,
		gatewayProps: input.gatewayProps,
		appCommitSha: input.env.APP_COMMIT_SHA ?? null,
		usageEnv: input.env,
	})
}

function createStableDynamicWorkerExecutor(input: DynamicWorkerExecutorInput) {
	const modules = removeReservedExecutorModule(input.modules)
	return {
		async execute(
			code: string,
			providers: Array<ResolvedProvider>,
		): Promise<ExecuteResult> {
			const validationError = validateProviders(providers)
			if (validationError) {
				return {
					result: undefined,
					error: validationError,
				}
			}
			const executorModule = createExecutorModule({
				code,
				providers,
				shadowGlobalThis: Object.keys(modules).length === 0,
				timeoutMs: input.timeout,
			})
			const workerOptions = {
				compatibilityDate: dynamicWorkerCompatibilityDate,
				compatibilityFlags: [...dynamicWorkerCompatibilityFlags],
				mainModule: dynamicWorkerMainModule,
				modules: {
					...modules,
					[dynamicWorkerMainModule]: executorModule,
				},
				globalOutbound: input.globalOutbound,
			}
			const workerId = await createStableDynamicWorkerId({
				appCommitSha: input.appCommitSha ?? null,
				gatewayProps: input.gatewayProps,
				timeoutMs: input.timeout,
				workerOptions,
			})
			const executionState = { active: true }
			const dispatchers = createToolDispatchers(providers, executionState)
			const startedAtMs = Date.now()
			let outcome: 'success' | 'error' = 'success'
			try {
				const entrypoint = input.loader
					.get(workerId, () => workerOptions)
					.getEntrypoint() as unknown as DynamicWorkerEntrypoint
				const response = await entrypoint.evaluate(dispatchers)
				if (response.error) {
					outcome = 'error'
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
			} catch (error) {
				outcome = 'error'
				throw error
			} finally {
				executionState.active = false
				if (input.gatewayProps.userId) {
					await recordUsage(input.usageEnv, {
						userId: input.gatewayProps.userId,
						eventType: 'execute',
						durationMs: Date.now() - startedAtMs,
						outcome,
					})
				}
			}
		},
	}
}

function validateProviders(providers: Array<ResolvedProvider>) {
	const seenNames = new Set<string>()
	for (const provider of providers) {
		if (reservedProviderNames.has(provider.name)) {
			return `Provider name "${provider.name}" is reserved`
		}
		if (!validProviderNamePattern.test(provider.name)) {
			return `Provider name "${provider.name}" is not a valid JavaScript identifier`
		}
		if (javascriptReservedWords.has(provider.name)) {
			return `Provider name "${provider.name}" is a JavaScript reserved word`
		}
		if (seenNames.has(provider.name)) {
			return `Duplicate provider name "${provider.name}"`
		}
		seenNames.add(provider.name)
	}
	return null
}

function createExecutorModule(input: {
	code: string
	providers: Array<ResolvedProvider>
	shadowGlobalThis: boolean
	timeoutMs: number
}) {
	const normalized = normalizeCode(input.code)
	const sandboxGlobalLines = input.shadowGlobalThis
		? [
				'    const __kodySandboxGlobalValues = Object.create(null);',
				'    const __kodySandboxGlobal = new Proxy(globalThis, {',
				'      get(target, property) {',
				'        return property in __kodySandboxGlobalValues ? __kodySandboxGlobalValues[property] : target[property];',
				'      },',
				'      set(_target, property, value) {',
				'        __kodySandboxGlobalValues[property] = value;',
				'        return true;',
				'      },',
				'      has(target, property) {',
				'        return property in __kodySandboxGlobalValues || property in target;',
				'      },',
				'    });',
			]
		: []
	const userCodeInvocation = input.shadowGlobalThis
		? [
				'        (async (globalThis, self, global) => (',
				normalized,
				')())(__kodySandboxGlobal, __kodySandboxGlobal, __kodySandboxGlobal),',
			]
		: ['        (', normalized, ')(),']
	return [
		'import { WorkerEntrypoint } from "cloudflare:workers";',
		'',
		'export default class CodeExecutor extends WorkerEntrypoint {',
		'  async evaluate(__dispatchers = {}) {',
		'    const __logs = [];',
		'    const console = {',
		'      log: (...a) => { __logs.push(a.map(String).join(" ")); },',
		'      warn: (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); },',
		'      error: (...a) => { __logs.push("[error] " + a.map(String).join(" ")); },',
		'    };',
		...sandboxGlobalLines,
		// Keep this aligned with upstream kody's sandbox dispatcher shape:
		// the dynamic worker source only names provider namespaces, while the
		// actual per-invocation tool implementations arrive through RPC dispatchers.
		...input.providers.map((provider) => createProviderProxySource(provider)),
		'',
		'    let __timeoutId;',
		'    try {',
		'      const __timeoutPromise = new Promise((_, reject) => {',
		`        __timeoutId = setTimeout(() => reject(new Error("Execution timed out")), ${input.timeoutMs});`,
		'      });',
		'      const result = await Promise.race([',
		...userCodeInvocation,
		'        __timeoutPromise',
		'      ]);',
		'      return { result, logs: __logs };',
		'    } catch (err) {',
		'      return { result: undefined, error: err.message, logs: __logs };',
		'    } finally {',
		'      clearTimeout(__timeoutId);',
		'    }',
		'  }',
		'}',
	].join('\n')
}

export function createExecutorModuleSource(input: {
	code: string
	providers: Array<ResolvedProvider>
	shadowGlobalThis: boolean
	timeoutMs: number
}) {
	return createExecutorModule(input)
}

function createProviderProxySource(provider: ResolvedProvider) {
	const kodyProvider = provider as KodyResolvedProvider
	if (
		provider.name === 'kody' &&
		(kodyProvider.kodyRemoteConnectors || kodyProvider.kodyMcpServers)
	) {
		return createKodyProviderProxySource({
			providerName: provider.name,
			remoteConnectors: kodyProvider.kodyRemoteConnectors ?? [],
			mcpServers: kodyProvider.kodyMcpServers ?? [],
		})
	}
	return provider.positionalArgs
		? `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`
		: `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args ?? {}));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`
}

export function createKodyProviderProxySource(input: {
	providerName: string
	remoteConnectors: Array<KodyRemoteConnectorMetadata>
	mcpServers?: Array<KodyMcpServerMetadata>
}) {
	const metadataJson = JSON.stringify(input.remoteConnectors)
	const mcpMetadataJson = JSON.stringify(input.mcpServers ?? [])
	const source = `    const __kodyCreateRemoteProxy = ${kodyRemoteProxyFactorySource};
    const __kodyCallDispatcher = async (dispatchName, args) => {
      const resJson = await __dispatchers.${input.providerName}.call(dispatchName, JSON.stringify(args ?? {}));
      const data = JSON.parse(resJson);
      if (data.error) throw new Error(data.error);
      return data.result;
    };
    const __kodyRemote = __kodyCreateRemoteProxy({
      remoteConnectors: ${metadataJson},
      callTool: __kodyCallDispatcher,
    });
    const __kodyMcp = __kodyCreateRemoteProxy({
      remoteConnectors: ${mcpMetadataJson},
      entityLabel: "MCP server",
      shortEntityLabel: "MCP server",
      capabilityLabel: "MCP tool",
      callTool: __kodyCallDispatcher,
    });
    const ${input.providerName} = new Proxy({}, {
      get: (_, toolName) => {
        if (typeof toolName === 'symbol' || toolName === 'then') return undefined;
        if (toolName === 'remote') return __kodyRemote;
        if (toolName === 'mcp') return __kodyMcp;
        const normalizedToolName = String(toolName);
        if (normalizedToolName.startsWith('remote:')) {
          throw new Error(\`Remote connector capability "\${normalizedToolName}" is not available as a flat kody function. Use kody.remote[connectorName].capabilityName(input) instead.\`);
        }
        if (normalizedToolName.startsWith('mcp:')) {
          throw new Error(\`MCP server tool "\${normalizedToolName}" is not available as a flat kody function. Use kody.mcp[serverName].toolName(input) instead.\`);
        }
        return async (args) => await __kodyCallDispatcher(normalizedToolName, args);
      }
    });`
	assertGeneratedExecutorSourceIsBundleSafe(source)
	return source
}

export function createToolDispatchers(
	providers: Array<ResolvedProvider>,
	executionState: { active: boolean },
) {
	const dispatchers: Record<string, ToolDispatcher> = {}
	for (const provider of providers) {
		const sanitizedFns: Record<
			string,
			(...args: Array<unknown>) => Promise<unknown>
		> = {}
		const rawNamesBySanitizedName = new Map<string, string>()
		for (const [name, fn] of Object.entries(provider.fns)) {
			const sanitizedName = sanitizeToolName(name)
			if (rawNamesBySanitizedName.has(sanitizedName)) {
				const existingName = rawNamesBySanitizedName.get(sanitizedName) ?? ''
				throw new Error(
					`Provider "${provider.name}" has tool names "${existingName}" and "${name}" that both sanitize to "${sanitizedName}".`,
				)
			}
			rawNamesBySanitizedName.set(sanitizedName, name)
			sanitizedFns[sanitizedName] = async (...args) => {
				if (!executionState.active) {
					throw new Error('Execution has already completed.')
				}
				return await fn(...args)
			}
		}
		dispatchers[provider.name] = new ToolDispatcher(
			sanitizedFns,
			provider.positionalArgs,
		)
	}
	return dispatchers
}

function removeReservedExecutorModule(
	modules: WorkerLoaderModules | undefined,
) {
	const { [dynamicWorkerMainModule]: _ignored, ...safeModules } = modules ?? {}
	return safeModules
}

async function createStableDynamicWorkerId(input: {
	appCommitSha: string | null
	gatewayProps: FetchGatewayProps
	timeoutMs: number
	workerOptions: DynamicWorkerExecutorOptions
}) {
	if (!canReuseDynamicWorkerId(input)) {
		return `${dynamicWorkerIdPrefix}${crypto.randomUUID()}`
	}
	const hash = await sha256Base64Url(
		canonicalJsonStringify({
			version: dynamicWorkerCacheKeyVersion,
			binding: 'LOADER',
			appCommitSha: input.appCommitSha,
			gatewayProps: input.gatewayProps,
			timeoutMs: input.timeoutMs,
			compatibilityDate: input.workerOptions.compatibilityDate,
			compatibilityFlags: input.workerOptions.compatibilityFlags,
			mainModule: input.workerOptions.mainModule,
			modules: input.workerOptions.modules,
		}),
	)
	return `${dynamicWorkerIdPrefix}${hash.slice(0, 43)}`
}

function canReuseDynamicWorkerId(input: {
	appCommitSha: string | null
	gatewayProps: FetchGatewayProps
	workerOptions: DynamicWorkerExecutorOptions
}) {
	if (!input.gatewayProps.userId) return false
	if (!input.appCommitSha) return false
	return areWorkerModulesDeterministicallyHashable(input.workerOptions.modules)
}

function areWorkerModulesDeterministicallyHashable(
	modules: WorkerLoaderModules,
) {
	for (const moduleValue of Object.values(modules)) {
		if (!isDeterministicallyHashableWorkerModule(moduleValue)) {
			return false
		}
	}
	return true
}

function isDeterministicallyHashableWorkerModule(
	moduleValue: WorkerLoaderModules[string],
) {
	if (typeof moduleValue === 'string') return true
	if (moduleValue === null || typeof moduleValue !== 'object') return false
	const record = moduleValue as Record<string, unknown>
	for (const key of ['js', 'cjs', 'text'] as const) {
		const value = record[key]
		if (value !== undefined && typeof value !== 'string') return false
	}
	if (record.data !== undefined && !(record.data instanceof ArrayBuffer)) {
		return false
	}
	if (
		record.json !== undefined &&
		!isDeterministicallyHashableValue(record.json)
	) {
		return false
	}
	for (const [key, value] of Object.entries(record)) {
		if (
			key !== 'js' &&
			key !== 'cjs' &&
			key !== 'text' &&
			key !== 'data' &&
			key !== 'json'
		) {
			return false
		}
		if (key === 'data' || key === 'json') continue
		if (value !== undefined && typeof value !== 'string') return false
	}
	return true
}

function isDeterministicallyHashableValue(value: unknown): boolean {
	if (value === null) return true
	const valueType = typeof value
	if (
		valueType === 'string' ||
		valueType === 'number' ||
		valueType === 'boolean'
	) {
		return true
	}
	if (valueType === 'bigint' || valueType === 'undefined') return true
	if (valueType === 'function' || valueType === 'symbol') return false
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
	if (Array.isArray(value)) {
		return value.every((entry) => isDeterministicallyHashableValue(entry))
	}
	if (valueType === 'object') {
		const record = value as Record<string, unknown>
		return Object.values(record).every((entry) =>
			isDeterministicallyHashableValue(entry),
		)
	}
	return false
}

function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeForHash(value))
}

function canonicalizeForHash(value: unknown): unknown {
	if (value === undefined) return { __kodyType: 'undefined' }
	if (value === null) return null
	if (typeof value === 'bigint')
		return { __kodyType: 'bigint', value: String(value) }
	if (typeof value !== 'object') return value
	if (value instanceof ArrayBuffer) {
		return {
			__kodyType: 'arrayBuffer',
			value: toBase64Url(new Uint8Array(value)),
		}
	}
	if (ArrayBuffer.isView(value)) {
		return {
			__kodyType: 'arrayBuffer',
			value: toBase64Url(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		}
	}
	if (Array.isArray(value))
		return value.map((entry) => canonicalizeForHash(entry))
	const record = value as Record<string, unknown>
	return Object.fromEntries(
		Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => [key, canonicalizeForHash(record[key])]),
	)
}

async function sha256Base64Url(value: string) {
	return toBase64Url(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
		),
	)
}

function toBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
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
			kind: 'secret_package_access_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			packageName: string
			approvalUrl: string | null
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_packages'
			}
	  }
	| {
			kind: 'secret_package_access_required_batch'
			message: string
			nextStep: string
			missingApprovals: Array<{
				secretName: string
				packageId: string
				kodyId: string | null
				approvalUrl: string
			}>
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_packages'
			}
	  }
	| {
			kind: 'secret_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			suggestedAction: {
				type: 'connect_secret'
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
	| {
			kind: 'entitlement_limit_exceeded'
			message: string
			nextStep: string
			details: EntitlementLimitErrorDetails
			suggestedAction: {
				type: 'review_plan_limit'
				resource: EntitlementLimitErrorDetails['resource']
			}
	  }

export function getExecutionErrorDetails(
	error: unknown,
): ExecutionErrorDetails | null {
	const message = stringifyExecutionError(error)

	if (isEntitlementLimitError(error)) {
		return toEntitlementExecutionErrorDetails(message, error.details)
	}

	const entitlementDetails = parseEntitlementLimitMessage(message)
	if (entitlementDetails) {
		return toEntitlementExecutionErrorDetails(message, entitlementDetails)
	}

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

	const packageAccessBatch = parsePackageAccessRequiredBatchMessage(message)
	if (packageAccessBatch) {
		return {
			kind: 'secret_package_access_required_batch',
			message,
			nextStep:
				'Ask the user whether they want to approve these packages for the listed secrets in the account secrets UI, then retry after approval.',
			missingApprovals: packageAccessBatch,
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_packages',
			},
		}
	}

	const packageAccessDetails = parsePackageAccessRequiredMessage(message)
	if (packageAccessDetails) {
		return {
			kind: 'secret_package_access_required',
			message,
			nextStep:
				"Ask the user whether this package should be allowed to use the secret. If they approve, help them add this package to the secret's allowed packages in the account secrets UI, then retry.",
			secretNames: [packageAccessDetails.secretName],
			packageName: packageAccessDetails.packageName,
			approvalUrl: extractFirstUrl(message),
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_packages',
			},
		}
	}

	const missingSecretDetails = parseMissingSecretMessage(message)
	if (missingSecretDetails) {
		return {
			kind: 'secret_required',
			message,
			nextStep: `Send the user to /account/secrets/new?name=${encodeURIComponent(missingSecretDetails.secretName)} so they can provide and save this secret, then retry the workflow.`,
			secretNames: [missingSecretDetails.secretName],
			suggestedAction: {
				type: 'connect_secret',
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

function toEntitlementExecutionErrorDetails(
	message: string,
	details: EntitlementLimitErrorDetails,
): ExecutionErrorDetails {
	return {
		kind: 'entitlement_limit_exceeded',
		message,
		nextStep: details.upgradeHint,
		details,
		suggestedAction: {
			type: 'review_plan_limit',
			resource: details.resource,
		},
	}
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) {
		const errorText = stringifyExecutionError(result.error)
		const details = getExecutionErrorDetails(result.error)
		if (!details) return `Error: ${errorText}`
		return `Error: ${errorText}\n\nNext step: ${details.nextStep}`
	}
	return stringifyExecutionValueForOutput(result.result)
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

export function limitExecutionResultValue(
	value: unknown,
	responseLimitBytes: number,
) {
	if (typeof value === 'string') {
		const returnedBytes = getUtf8ByteLength(value)
		if (returnedBytes <= responseLimitBytes) {
			return {
				value,
				displayText: value,
				returnedBytes,
				truncated: false,
			} as const
		}
		const note = `Returned value was ${returnedBytes.toLocaleString()} bytes, exceeding responseLimit ${responseLimitBytes.toLocaleString()} bytes; output was truncated. Project fields before returning.`
		return {
			value: truncateUtf8String(value, responseLimitBytes),
			returnedBytes,
			truncated: true,
			note,
		} as const
	}

	const compactSerialized = JSON.stringify(value) ?? 'undefined'
	const returnedBytes = getUtf8ByteLength(compactSerialized)

	if (returnedBytes <= responseLimitBytes) {
		return {
			value,
			displayText: JSON.stringify(value, null, 2) ?? 'undefined',
			returnedBytes,
			truncated: false,
		} as const
	}

	const note = `Returned value was ${returnedBytes.toLocaleString()} bytes, exceeding responseLimit ${responseLimitBytes.toLocaleString()} bytes; output was truncated. Project fields before returning.`
	const truncatedValue = {
		truncated: true,
		type: describeExecutionValue(value),
	}

	return {
		value: truncatedValue,
		displayText: JSON.stringify(truncatedValue, null, 2) ?? 'undefined',
		returnedBytes,
		truncated: true,
		note,
	} as const
}

export function formatLimitedExecutionOutput(input: {
	value: unknown
	truncated: boolean
	note?: string
	displayText?: string
}) {
	const text =
		input.displayText ?? stringifyExecutionValueForOutput(input.value)
	if (!input.truncated) return text
	return `${text}\n\n--- TRUNCATED ---\n${input.note}`
}

function stringifyExecutionValueForOutput(value: unknown) {
	if (typeof value === 'string') return value
	return JSON.stringify(value, null, 2) ?? 'undefined'
}

function truncateUtf8String(value: string, maxBytes: number) {
	const encoder = new TextEncoder()
	let usedBytes = 0
	let result = ''
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength
		if (usedBytes + characterBytes > maxBytes) break
		result += character
		usedBytes += characterBytes
	}
	return result
}

function getUtf8ByteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}

function describeExecutionValue(value: unknown) {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	return typeof value
}
