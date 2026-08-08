import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	resolveProvider,
	sanitizeToolName,
	type ExecuteResult,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { createExecuteExecutor } from '#mcp/executor.ts'
import { type RawFetchHostSink } from '#mcp/raw-fetch-host-nudge.ts'
import {
	getAdditionalPropertiesSchema,
	getArrayItemSchema,
	getSchemaProperties,
	isSecretInputSchema,
	resolveCapabilityInputSecrets,
} from '#mcp/secrets/capability-inputs.ts'
import {
	capabilityInputSecretAuthRequiredMessage,
	createCapabilitySecretAccessDeniedMessage,
	createCapabilitySecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import {
	assertPackageCanAccessResolvedSecret,
	resolvePackageMountedSecret,
} from '#mcp/secrets/package-access.ts'
import { buildSecretCapabilityApprovalUrl } from '#mcp/secrets/capability-approval-url.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { type ReferencedSecret } from '#mcp/secrets/placeholders.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import {
	type KodyMcpServerMetadata,
	type KodyOpenApiProviderMetadata,
	type KodyRemoteConnectorMetadata,
	type KodyResolvedProvider,
} from '#mcp/kody-remote-types.ts'
import { openApiProviderKodyName } from '#worker/openapi/openapi-domain-id.ts'
import {
	createRuntimeHelperExtraProviders,
	createRuntimeHelperKodyToolSets,
	createRuntimeHelperPreludes,
	createRuntimeHelperRuntimePropertySource,
	createUnboundOptionalRuntimeHelperNames,
	type AdditionalKodyTools,
	type EmailToolOptions,
	type PackageEventTools,
	type PackageInvokeTools,
	type PackageSecretToolOptions,
	type PackageStorageToolOptions,
	type PackageWorkflowTools,
	type ServiceToolOptions,
	type StorageToolOptions,
} from '#mcp/runtime-helper-manifest.ts'
import {
	buildKodyModuleBundle,
	hydrateKodyRuntimeModules,
} from '#worker/package-runtime/module-graph.ts'
import {
	collectLiteralImportSpecifiers,
	getBarePackageNameFromSpecifier,
} from '#worker/package-runtime/import-specifiers.ts'
import {
	createUnboundRuntimeHelperMessage,
	findUnboundRuntimeHelperAccess,
} from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { createDynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { type BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { createPackageStaticCallMeterTools } from '#worker/usage/package-static-call-usage.ts'
import { recordAgentPackageConversationUses } from '#worker/usage/agent-package-conversation-uses.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	formatRemoteConnectorUnavailableMessage,
	getRemoteConnectorStatus,
} from '#worker/remote-connector/status.ts'
import { remoteConnectorKodyName } from '#worker/remote-connector/remote-domain-id.ts'
import {
	formatMcpServerUnavailableMessage,
	getMcpServerStatus,
} from '#worker/mcp-client/status.ts'
import { mcpServerKodyName } from '#worker/mcp-client/mcp-domain-id.ts'
import { listEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'

type ExecuteServerTimingEntry = {
	name: string
	durationMs: number
}

export type {
	PackageEventDispatchInput,
	PackageEventTools,
	PackageInvokeCheckResult,
	PackageInvokeContract,
	PackageInvokeInput,
	PackageInvokeNormalizedInput,
	PackageInvokeTools,
	PackageWorkflowTools,
} from '#mcp/runtime-helper-manifest.ts'

export type PackageContextOptions = {
	packageId: string
	kodyId: string
	sourceId?: string | null
} | null

export function createAdHocExecuteSourceFiles(code: string) {
	const sourceFiles: Record<string, string> = { 'entry.ts': code }
	// Most execute modules have no imports. Avoid parsing those entirely so the
	// existing one-file fast path stays unchanged.
	if (!code.includes('import') && !code.includes(' from ')) return sourceFiles
	const packageNames = new Set<string>()
	for (const specifier of collectLiteralImportSpecifiers(code)) {
		const packageName = getBarePackageNameFromSpecifier(specifier)
		if (packageName) packageNames.add(packageName)
	}
	if (packageNames.size === 0) return sourceFiles
	const dependencies = Object.fromEntries(
		[...packageNames]
			.sort((left, right) => left.localeCompare(right))
			.map((packageName) => [packageName, 'latest']),
	)
	sourceFiles['package.json'] = JSON.stringify({ dependencies })
	return sourceFiles
}

/** Once per isolate: sample the first kody.* capability RPC wall time. */
let firstCapabilityDispatchSampled = false
const firstCapabilityDispatchWarnMs = 250

function isPackageSecretAvailabilityError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.startsWith('Secret "') ||
			error.message.startsWith('Package "'))
	)
}

function createPackageSecretTools(input: {
	env: Env
	callerContext: McpCallerContext
	packageId: string
}): PackageSecretToolOptions {
	return {
		get: async (alias: string) =>
			(
				await resolvePackageMountedSecret({
					env: input.env,
					callerContext: input.callerContext,
					packageId: input.packageId,
					alias,
				})
			).value,
		has: async (alias: string) => {
			try {
				await resolvePackageMountedSecret({
					env: input.env,
					callerContext: input.callerContext,
					packageId: input.packageId,
					alias,
				})
				return true
			} catch (error) {
				if (isPackageSecretAvailabilityError(error)) {
					return false
				}
				throw error
			}
		},
	}
}

export function createWorkflowTools(input: {
	env: Env
	callerContext: McpCallerContext
	packageContext: PackageContextOptions
}): PackageWorkflowTools {
	const packageContext = input.packageContext
	return {
		create: async (body) => {
			const userId = input.callerContext.user?.userId
			if (!userId) {
				throw new Error('workflows.create requires an authenticated user.')
			}
			return await createDynamicCallableWorkflow({
				env: input.env,
				userId,
				userEmail: input.callerContext.user?.email,
				packageContext,
				body,
			})
		},
	}
}

export async function buildKodyFns(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		resolveSecretValue?: (
			secret: ReferencedSecret,
			capabilityName: string,
		) => Promise<string>
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		storageTools?: StorageToolOptions
		packageStorageTools?: PackageStorageToolOptions
		serviceTools?: ServiceToolOptions
		packageSecretTools?: PackageSecretToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
	},
) {
	return (await buildKodyToolContext(env, callerContext, options)).tools
}

async function buildKodyToolContext(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		resolveSecretValue?: (
			secret: ReferencedSecret,
			capabilityName: string,
		) => Promise<string>
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		storageTools?: StorageToolOptions
		packageStorageTools?: PackageStorageToolOptions
		serviceTools?: ServiceToolOptions
		packageSecretTools?: PackageSecretToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
	},
): Promise<{
	tools: AdditionalKodyTools
	remoteConnectors: Array<KodyRemoteConnectorMetadata>
	mcpServers: Array<KodyMcpServerMetadata>
	openApiProviders: Array<KodyOpenApiProviderMetadata>
}> {
	const capabilityMap = options?.skipCapabilityRegistry
		? {}
		: options?.capabilityRegistry
			? options.capabilityRegistry.capabilityMap
			: (
					await getCapabilityRegistryForContext({
						env,
						callerContext,
					})
				).capabilityMap
	const [remoteConnectors, mcpServers, openApiProviders] = await Promise.all([
		buildKodyRemoteConnectorMetadata({
			env,
			callerContext,
			capabilityMap,
		}),
		buildKodyMcpServerMetadata({
			env,
			callerContext,
			capabilityMap,
		}),
		buildKodyOpenApiProviderMetadata({
			capabilityMap,
		}),
	])
	const additionalTools = options?.additionalTools ?? {}
	const storageTools = options?.storageTools
	assertNoCapabilityCollisions(capabilityMap, additionalTools)
	const capabilityKodyTools = Object.fromEntries(
		Object.entries(capabilityMap).map(([capabilityName, capability]) => [
			capabilityName,
			async (args: unknown) => {
				// First capability RPC in a cold isolate often pays for lazy module
				// graphs behind handlers; log once so regressions stay visible.
				const shouldSampleFirstDispatch = !firstCapabilityDispatchSampled
				const dispatchStartedAtMs = shouldSampleFirstDispatch ? Date.now() : 0
				if (shouldSampleFirstDispatch) {
					firstCapabilityDispatchSampled = true
				}
				try {
					await assertCallerCanAccessCapability(callerContext, capability, {
						env,
					})
					const resolveSecretValue =
						options?.resolveSecretValue ??
						createCapabilityInputSecretResolver(
							env,
							callerContext,
							capabilityName,
						)
					const resolvedArgs = await resolveCapabilityInputSecrets({
						schema: capability.inputSchema,
						value: (args ?? {}) as Record<string, unknown>,
						resolveSecretValue: (secret) =>
							resolveSecretValue(secret, capabilityName),
					})
					collectSecretInputValues({
						schema: capability.inputSchema,
						value: resolvedArgs,
						track: options?.trackSecretInputValue,
					})
					return await capability.handler(
						resolvedArgs as Record<string, unknown>,
						{
							env,
							callerContext,
						},
					)
				} finally {
					if (shouldSampleFirstDispatch) {
						const durationMs = Date.now() - dispatchStartedAtMs
						if (durationMs >= firstCapabilityDispatchWarnMs) {
							console.warn('kody-first-capability-dispatch-slow', {
								capabilityName,
								durationMs,
							})
						}
					}
				}
			},
		]),
	) as AdditionalKodyTools
	const runtimeHelperKodyToolSets = await createRuntimeHelperKodyToolSets({
		env,
		callerContext,
		capabilityMap,
		storageTools,
		packageStorageTools: options?.packageStorageTools,
		serviceTools: options?.serviceTools,
		packageSecretTools: options?.packageSecretTools,
		emailTools: options?.emailTools,
		workflowTools: options?.workflowTools,
	})
	for (const { tools } of runtimeHelperKodyToolSets) {
		assertNoCapabilityCollisions(capabilityMap, tools)
	}
	const runtimeHelperKodyTools = Object.assign(
		{},
		...runtimeHelperKodyToolSets.map(({ tools }) => tools),
	) as AdditionalKodyTools
	return {
		tools: {
			...capabilityKodyTools,
			...runtimeHelperKodyTools,
			...additionalTools,
		},
		remoteConnectors,
		mcpServers,
		openApiProviders,
	}
}

function assertNoCapabilityCollisions(
	capabilityMap: Record<string, unknown>,
	tools: AdditionalKodyTools,
) {
	for (const name of Object.keys(tools)) {
		if (capabilityMap[name]) {
			throw new Error(`Kody helper "${name}" collides with a capability.`)
		}
	}
}

async function buildKodyRemoteConnectorMetadata(input: {
	env: Env
	callerContext: McpCallerContext
	capabilityMap: Record<string, Capability>
}): Promise<Array<KodyRemoteConnectorMetadata>> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	const connectors = new Map<string, KodyRemoteConnectorMetadata>()

	for (const ref of refs) {
		const name = remoteConnectorKodyName(ref)
		const status = userId
			? await getRemoteConnectorStatus({
					env: input.env,
					userId,
					ref,
				})
			: {
					state: 'unavailable' as const,
					connectorId: ref.instanceId,
					connected: false,
					connectedAt: null,
					lastSeenAt: null,
					toolCount: 0,
					message: `Remote connector "${name}" requires an authenticated user.`,
					error: null,
				}
		connectors.set(name, {
			name,
			instanceId: ref.instanceId,
			status: {
				state: status.state,
				connected: status.connected,
				toolCount: status.toolCount,
				message: status.message,
				unavailableMessage: formatRemoteConnectorUnavailableMessage(status),
			},
			capabilities: [],
		})
	}

	for (const capability of Object.values(input.capabilityMap)) {
		if (capability.source !== 'remote-connector') continue
		const remote = capability.remoteConnector
		if (!remote) continue
		const existing =
			connectors.get(remote.connectorName) ??
			({
				name: remote.connectorName,
				instanceId: remote.instanceId,
				status: {
					state: 'connected',
					connected: true,
					toolCount: 0,
					message: `The "${remote.instanceId}" connector is connected.`,
					unavailableMessage: `The "${remote.instanceId}" connector is connected.`,
				},
				capabilities: [],
			} satisfies KodyRemoteConnectorMetadata)
		existing.capabilities.push({
			name: remote.toolName,
			dispatchName: sanitizeToolName(capability.name),
		})
		existing.capabilities.sort((a, b) => a.name.localeCompare(b.name, 'en'))
		existing.status.toolCount = Math.max(
			existing.status.toolCount,
			existing.capabilities.length,
		)
		connectors.set(remote.connectorName, existing)
	}

	return [...connectors.values()].sort((a, b) =>
		a.name.localeCompare(b.name, 'en'),
	)
}

async function buildKodyMcpServerMetadata(input: {
	env: Env
	callerContext: McpCallerContext
	capabilityMap: Record<string, Capability>
}): Promise<Array<KodyMcpServerMetadata>> {
	const userId = input.callerContext.user?.userId ?? null
	const servers = new Map<string, KodyMcpServerMetadata>()

	if (userId) {
		// Per-user 30s cache: runtime metadata assembly runs on every execute /
		// package invocation, so this must not cost a D1 read per call.
		const refs = await listEnabledMcpServerRefsCached({
			env: input.env,
			userId,
		}).catch((error: unknown) => {
			// Degrade to "no MCP servers" but leave a trail: silently losing
			// kody.mcp[...] accessors is very hard to debug otherwise.
			console.warn('mcp-server-refs-load-failed', error)
			return []
		})
		for (const ref of refs) {
			const name = mcpServerKodyName(ref)
			const status = await getMcpServerStatus({
				env: input.env,
				userId,
				ref,
			})
			servers.set(name, {
				name,
				serverId: ref.serverId,
				status: {
					state: status.state,
					connected: status.ready,
					toolCount: status.toolCount,
					message: status.message,
					unavailableMessage: formatMcpServerUnavailableMessage(status),
				},
				capabilities: [],
			})
		}
	}

	for (const capability of Object.values(input.capabilityMap)) {
		if (capability.source !== 'mcp-server') continue
		const mcpServer = capability.mcpServer
		if (!mcpServer) continue
		const existing =
			servers.get(mcpServer.kodyName) ??
			({
				name: mcpServer.kodyName,
				serverId: mcpServer.serverId,
				status: {
					state: 'ready',
					connected: true,
					toolCount: 0,
					message: `The MCP server "${mcpServer.serverName}" is connected.`,
					unavailableMessage: `The MCP server "${mcpServer.serverName}" is connected.`,
				},
				capabilities: [],
			} satisfies KodyMcpServerMetadata)
		existing.capabilities.push({
			name: mcpServer.toolName,
			dispatchName: sanitizeToolName(capability.name),
		})
		existing.capabilities.sort((a, b) => a.name.localeCompare(b.name, 'en'))
		existing.status.toolCount = Math.max(
			existing.status.toolCount,
			existing.capabilities.length,
		)
		servers.set(mcpServer.kodyName, existing)
	}

	return [...servers.values()].sort((a, b) =>
		a.name.localeCompare(b.name, 'en'),
	)
}

async function buildKodyOpenApiProviderMetadata(input: {
	capabilityMap: Record<string, Capability>
}): Promise<Array<KodyOpenApiProviderMetadata>> {
	const providers = new Map<string, KodyOpenApiProviderMetadata>()

	for (const capability of Object.values(input.capabilityMap)) {
		if (capability.source !== 'openapi') continue
		const openApi = capability.openApi
		if (!openApi) continue
		const kodyName =
			openApi.kodyName || openApiProviderKodyName(openApi.bindingName)
		const existing =
			providers.get(kodyName) ??
			({
				name: kodyName,
				bindingName: openApi.bindingName,
				status: {
					state: 'connected',
					connected: true,
					toolCount: 0,
					message: `The OpenAPI provider "${openApi.bindingName}" is connected.`,
					unavailableMessage: `The OpenAPI provider "${openApi.bindingName}" is connected.`,
				},
				capabilities: [],
			} satisfies KodyOpenApiProviderMetadata)
		existing.capabilities.push({
			name: openApi.operationSlug,
			dispatchName: sanitizeToolName(capability.name),
		})
		existing.capabilities.sort((a, b) => a.name.localeCompare(b.name, 'en'))
		existing.status.toolCount = Math.max(
			existing.status.toolCount,
			existing.capabilities.length,
		)
		providers.set(kodyName, existing)
	}

	return [...providers.values()].sort((a, b) =>
		a.name.localeCompare(b.name, 'en'),
	)
}

export async function buildKodyProvider(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		storageTools?: StorageToolOptions
		packageStorageTools?: PackageStorageToolOptions
		serviceTools?: ServiceToolOptions
		packageSecretTools?: PackageSecretToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
	},
): Promise<ResolvedProvider> {
	const { tools, remoteConnectors, mcpServers, openApiProviders } =
		await buildKodyToolContext(env, callerContext, options)
	const provider: ToolProvider = {
		name: 'kody',
		tools: Object.fromEntries(
			Object.entries(tools).map(([name, execute]) => [
				name,
				{
					execute,
				},
			]),
		),
	}
	return Object.assign(resolveProvider(provider), {
		kodyRemoteConnectors: remoteConnectors,
		kodyMcpServers: mcpServers,
		kodyOpenApiProviders: openApiProviders,
	}) satisfies KodyResolvedProvider
}

function createCapabilityInputSecretResolver(
	env: Env,
	callerContext: McpCallerContext,
	capabilityName: string,
) {
	return async (secret: ReferencedSecret, _currentCapabilityName: string) => {
		const userId = callerContext.user?.userId ?? null
		if (!userId) {
			throw new Error(capabilityInputSecretAuthRequiredMessage)
		}
		const normalizedStorageContext = normalizeStorageContext(
			callerContext.storageContext ?? null,
		)
		const resolved = await resolveSecret({
			env,
			userId,
			name: secret.name,
			scope: secret.scope,
			storageContext: normalizedStorageContext,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(createMissingSecretMessage(secret.name))
		}
		await assertPackageCanAccessResolvedSecret({
			env,
			baseUrl: callerContext.baseUrl,
			userId,
			storageContext: callerContext.storageContext,
			secretName: secret.name,
			resolved,
		})
		if (!resolved.allowedCapabilities.includes(capabilityName)) {
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: callerContext.baseUrl,
				name: secret.name,
				scope: resolved.scope ?? secret.scope ?? 'user',
				capabilityName,
				storageContext: normalizedStorageContext,
			})
			throw new Error(
				createCapabilitySecretAccessDeniedMessage(
					secret.name,
					capabilityName,
					approvalUrl,
				),
			)
		}
		return resolved.value
	}
}

export async function runModuleWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalKodyTools
		storageTools?: StorageToolOptions
		serviceTools?: ServiceToolOptions
		packageContext?: PackageContextOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		executorTimeoutMs?: number | null
		signal?: AbortSignal
		packageInvokeTools?: PackageInvokeTools
		packageEventTools?: PackageEventTools
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		/**
		 * When set (MCP public `execute` tool), static/dynamic `kody:@…`
		 * package deps are credited toward agent-facing package popularity.
		 */
		conversationId?: string | null
		runRecord?: RunRecordContext | null
		runRecordHandle?: RunRecordHandle | null
		/**
		 * When set, post-terminal run-record side effects are scheduled on this
		 * callback (typically `ctx.waitUntil`). The terminal Durable Object write
		 * itself is always awaited so a completed invocation is not stranded as
		 * `running`.
		 */
		waitUntil?: (promise: Promise<unknown>) => void
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<{ name: string; durationMs: number }>
	}
> {
	const userId = callerContext.user?.userId ?? ''
	const serverTiming: Array<{ name: string; durationMs: number }> = []
	const bundleStartedAtMs = Date.now()
	const bundled = await buildKodyModuleBundle({
		env,
		baseUrl: callerContext.baseUrl,
		userId,
		sourceFiles: createAdHocExecuteSourceFiles(code),
		entryPoint: 'entry.ts',
		reuseCachedBundle: true,
		bundleContext: 'ad-hoc-execute',
	})
	serverTiming.push({
		name: 'bundle',
		durationMs: Date.now() - bundleStartedAtMs,
	})
	const conversationId = options?.conversationId?.trim()
	if (conversationId && userId) {
		const packageIds = bundled.dependencies
			.map((dependency) => dependency.packageId)
			.filter((packageId): packageId is string => Boolean(packageId))
		if (packageIds.length > 0) {
			void recordAgentPackageConversationUses(env, {
				userId,
				packageIds,
				conversationId,
			})
		}
	}
	const runStartedAtMs = Date.now()
	const result = await runBundledModuleWithRegistry(
		env,
		callerContext,
		{
			mainModule: bundled.mainModule,
			modules: bundled.modules,
			dependencies: bundled.dependencies,
		},
		params,
		{
			...options,
			packageContext: options?.packageContext ?? null,
			workflowTools:
				options?.workflowTools ??
				createWorkflowTools({
					env,
					callerContext,
					packageContext: options?.packageContext ?? null,
				}),
			packageInvokeTools: options?.packageInvokeTools,
			packageEventTools: options?.packageEventTools,
			conversationId: options?.conversationId ?? null,
		},
	)
	// The bundled run reports its own sub-phases (hydrate, provider-assembly,
	// sandbox); `run` is their enclosing wall-clock span.
	serverTiming.push(...(result.serverTiming ?? []), {
		name: 'run',
		durationMs: Date.now() - runStartedAtMs,
	})
	return { ...result, serverTiming }
}

/**
 * `packageStorage()` grant set for one bundled run, from bundler/host
 * controlled provenance only: the run's own package context, the saved
 * packages recorded in the bundle's static dependency metadata, and the
 * published artifacts installed for literal dynamic package imports during
 * hydration. Sandbox-supplied strings never extend this set, which is what
 * keeps a malicious module from claiming another installed package's bucket.
 */
export function collectPackageStorageGrantIds(input: {
	packageContext: PackageContextOptions
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencyPackageIds: Array<string>
}): ReadonlySet<string> {
	const grantedPackageIds = new Set<string>()
	if (input.packageContext?.packageId) {
		grantedPackageIds.add(input.packageContext.packageId)
	}
	for (const dependency of input.dependencies) {
		if (dependency.packageId) {
			grantedPackageIds.add(dependency.packageId)
		}
	}
	for (const packageId of input.dynamicDependencyPackageIds) {
		grantedPackageIds.add(packageId)
	}
	return grantedPackageIds
}

export async function runBundledModuleWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	bundle: {
		mainModule: string
		modules: WorkerLoaderModules
		/**
		 * Bundle dependency metadata recorded at build time (static
		 * `kody:@scope/package` imports). Used as provenance for
		 * `packageStorage()` grants; omit it and only the run's own package
		 * context is granted.
		 */
		dependencies?: Array<BundleArtifactDependency>
	},
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalKodyTools
		storageTools?: StorageToolOptions
		packageContext?: PackageContextOptions
		serviceContext?: {
			serviceName: string
		} | null
		serviceTools?: ServiceToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		packageInvokeTools?: PackageInvokeTools
		packageEventTools?: PackageEventTools
		skipCapabilityRegistry?: boolean
		executorTimeoutMs?: number | null
		signal?: AbortSignal
		runRecord?: RunRecordContext | null
		/**
		 * Pre-claimed handle from {@link claimRunRecord} (keyed execute). When
		 * set, begin is skipped so the running row already owns the key.
		 */
		runRecordHandle?: RunRecordHandle | null
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		conversationId?: string | null
		/**
		 * When set, post-terminal run-record side effects are scheduled on this
		 * callback (typically `ctx.waitUntil`). The terminal Durable Object write
		 * itself is always awaited.
		 */
		waitUntil?: (promise: Promise<unknown>) => void
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<ExecuteServerTimingEntry>
	}
> {
	const runServerTiming: Array<ExecuteServerTimingEntry> = []
	const secretRedactor = createExecutionSecretRedactor()
	const normalizedStorageContext = normalizeStorageContext(
		callerContext.storageContext ?? null,
	)
	const runRecordContext = options?.runRecord
		? {
				...options.runRecord,
				storageId:
					options.runRecord.storageId ??
					options.storageTools?.storageId ??
					normalizedStorageContext?.storageId ??
					null,
			}
		: null
	const waitUntil = options?.waitUntil
	const runRecordHandle =
		options?.runRecordHandle ??
		beginRunRecord({
			env,
			userId: callerContext.user?.userId ?? null,
			context: runRecordContext,
			waitUntil,
		})
	let runRecordFinished = false
	let exposeRunId = runRecordHandle?.persistence === 'eager'
	// The metering span covers the whole bundled run (module hydration,
	// provider assembly, and sandbox execution) so pre-executor failures are
	// still counted as failed package runs.
	const usageStartedAtMs = Date.now()
	let usageRecorded = false
	async function recordPackageExportUsage(outcome: 'success' | 'error') {
		if (usageRecorded) return
		usageRecorded = true
		const userId = callerContext.user?.userId
		if (!options?.packageContext || !userId) return
		await recordUsage(env, {
			userId,
			eventType: 'package_export',
			entityId: options.packageContext.packageId,
			durationMs: Date.now() - usageStartedAtMs,
			outcome,
		})
	}
	async function finishObservedRun(input: {
		status: 'success' | 'error'
		logs?: Array<string>
		error?: unknown
		result?: unknown
	}) {
		if (input.status === 'error') {
			exposeRunId = Boolean(runRecordHandle)
		}
		await finishRunRecord({
			env,
			handle: runRecordHandle,
			status: input.status,
			logs: input.logs,
			error: input.error,
			result: input.result,
			waitUntil,
		})
		runRecordFinished = true
	}
	function withRunId<T extends ExecuteResult>(
		result: T,
	): T & { runId?: string; serverTiming?: Array<ExecuteServerTimingEntry> } {
		const timed =
			runServerTiming.length > 0
				? { ...result, serverTiming: [...runServerTiming] }
				: result
		if (!exposeRunId || !runRecordHandle) return timed
		return { ...timed, runId: runRecordHandle.id }
	}
	try {
		// Hydration can install additional published-package sources (literal
		// dynamic `import("kody:@...")` targets); keep a reference so error
		// rewriting below scans the same module graph the sandbox executed.
		const hydrateStartedAtMs = Date.now()
		const { modules: hydratedModules, dynamicDependencyPackageIds } =
			await hydrateKodyRuntimeModules({
				env,
				baseUrl: callerContext.baseUrl,
				userId: callerContext.user?.userId ?? '',
				modules: bundle.modules,
			})
		runServerTiming.push({
			name: 'hydrate',
			durationMs: Date.now() - hydrateStartedAtMs,
		})
		const agentConversationId = options?.conversationId?.trim()
		const agentUserId = callerContext.user?.userId
		if (
			agentConversationId &&
			agentUserId &&
			dynamicDependencyPackageIds.length > 0
		) {
			void recordAgentPackageConversationUses(env, {
				userId: agentUserId,
				packageIds: dynamicDependencyPackageIds,
				conversationId: agentConversationId,
			})
		}
		const providerAssemblyStartedAtMs = Date.now()
		const grantedPackageStorageIds = collectPackageStorageGrantIds({
			packageContext: options?.packageContext ?? null,
			dependencies: bundle.dependencies ?? [],
			dynamicDependencyPackageIds,
		})
		// Static package export calls report through a sandbox bridge with a
		// bundler-stamped callee package id; only ids recorded as *static*
		// bundle dependencies at build time are accepted (mismatches are
		// dropped host-side). This is deliberately tighter than the
		// packageStorage grant set, which additionally includes the run's own
		// package id and dynamic-import dependencies — neither of which the
		// bundler ever stamps into a metered static import proxy.
		const staticCallMeterTools = createPackageStaticCallMeterTools({
			env,
			userId: callerContext.user?.userId ?? null,
			grantedPackageIds: new Set(
				(bundle.dependencies ?? [])
					.map((dependency) => dependency.packageId)
					.filter((packageId): packageId is string => Boolean(packageId)),
			),
		})
		const executor = createExecuteExecutor({
			env,
			exports: options?.executorExports ?? workerExports,
			timeoutMs: options?.executorTimeoutMs,
			signal: options?.signal,
			gatewayProps: {
				baseUrl: callerContext.baseUrl,
				userId: callerContext.user?.userId ?? null,
				email: callerContext.user?.email ?? null,
				storageContext: normalizedStorageContext,
			},
			modules: hydratedModules,
			// Package-context runs are saved-package code; do not count their fetch hosts.
			rawFetchHostSink: options?.packageContext
				? undefined
				: options?.rawFetchHostSink,
		})
		const workflowTools =
			options?.workflowTools ??
			createWorkflowTools({
				env,
				callerContext,
				packageContext: options?.packageContext ?? null,
			})
		// Register the package_storage_* tools whenever the run has a user, even
		// with an empty grant set: an unauthorized packageStorage() call then
		// fails with the structured provenance message instead of a bare
		// missing-capability TypeError.
		const packageStorageTools = callerContext.user?.userId
			? { grantedPackageIds: grantedPackageStorageIds }
			: undefined
		const packageSecretTools = options?.packageContext
			? createPackageSecretTools({
					env,
					callerContext,
					packageId: options.packageContext.packageId,
				})
			: undefined
		const provider = await buildKodyProvider(env, callerContext, {
			trackSecretInputValue: (value) => {
				secretRedactor.track(value)
			},
			additionalTools: options?.additionalTools,
			storageTools: options?.storageTools,
			packageStorageTools,
			serviceTools: options?.serviceTools,
			packageSecretTools,
			emailTools: options?.emailTools,
			workflowTools,
			skipCapabilityRegistry: options?.skipCapabilityRegistry,
			capabilityRegistry: options?.capabilityRegistry,
		})
		runServerTiming.push({
			name: 'provider-assembly',
			durationMs: Date.now() - providerAssemblyStartedAtMs,
		})
		const runtimeHelperContext = {
			env,
			callerContext,
			capabilityMap: {},
			provider,
			storageTools: options?.storageTools,
			packageStorageTools,
			serviceTools: options?.serviceTools,
			packageSecretTools,
			emailTools: options?.emailTools,
			workflowTools,
			packageInvokeTools: options?.packageInvokeTools,
			packageEventTools: options?.packageEventTools,
			staticCallMeterTools,
		}
		const runtimeHelperPreludes =
			createRuntimeHelperPreludes(runtimeHelperContext)
		const runtimeHelperPreludeSource =
			runtimeHelperPreludes.length > 0
				? `${runtimeHelperPreludes.join('\n')}\n`
				: ''
		// Mirrors the `__kodyRuntime` object below: a helper whose prelude is
		// omitted reaches the sandbox as `undefined` / `null`, so guard-less
		// access to it is what the unbound-helper error rewrite looks for.
		const unboundOptionalRuntimeHelperNames =
			createUnboundOptionalRuntimeHelperNames(runtimeHelperContext)
		const runtimeHelperRuntimePropertySource =
			createRuntimeHelperRuntimePropertySource()
		const entrypointInputJson = JSON.stringify(params)
		const entrypointInputSource =
			entrypointInputJson === undefined ? 'undefined' : entrypointInputJson
		const wrapped = `async () => {
${runtimeHelperPreludeSource}
  const { AsyncLocalStorage: __KodyAsyncLocalStorage } = await import('node:async_hooks');
  const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
  const __kodyGlobal = globalThis;
  const __kodyRuntimeStorage =
    __kodyGlobal[__kodyRuntimeStorageSymbol] ??
    (__kodyGlobal[__kodyRuntimeStorageSymbol] = new __KodyAsyncLocalStorage());
  const __kodyRuntime = {
    kody,
${runtimeHelperRuntimePropertySource}
    packageContext: ${JSON.stringify(options?.packageContext ?? null)},
    serviceContext: ${JSON.stringify(options?.serviceContext ?? null)},
  };
  try {
    return await __kodyRuntimeStorage.run(__kodyRuntime, async () => {
      const __kodyModule = await import(${JSON.stringify(`./${bundle.mainModule}`)});
      const __kodyEntrypoint = __kodyModule?.default;
      if (typeof __kodyEntrypoint !== 'function') {
        throw new Error('Kody execute modules must default export a function.');
      }
      return await __kodyEntrypoint(${entrypointInputSource});
    });
  } finally {
    // Deliver buffered static package export call usage events while the
    // sandbox RPC dispatchers are still live. Metering never breaks the
    // run it observes, and the bounded race keeps a slow metering bridge
    // from owning the run's tail latency.
    if (typeof __kodyStaticCallMeter !== 'undefined' && __kodyStaticCallMeter != null) {
      try {
        let __kodyStaticCallMeterFlushTimer;
        await Promise.race([
          __kodyStaticCallMeter.flush(),
          new Promise((resolve) => {
            __kodyStaticCallMeterFlushTimer = setTimeout(resolve, 2_000);
          }),
        ]);
        clearTimeout(__kodyStaticCallMeterFlushTimer);
      } catch {}
    }
  }
}`
		try {
			const providers: Array<ResolvedProvider> = [
				provider,
				...createRuntimeHelperExtraProviders(runtimeHelperContext),
			]
			const sandboxStartedAtMs = Date.now()
			const result = await executor.execute(wrapped, providers)
			runServerTiming.push({
				name: 'sandbox',
				durationMs: Date.now() - sandboxStartedAtMs,
			})
			const sanitizedResult = secretRedactor.sanitizeExecuteResult(result)
			if (!result.error) {
				await finishObservedRun({
					status: 'success',
					logs: sanitizedResult.logs ?? [],
					result: sanitizedResult.result,
				})
				await recordPackageExportUsage('success')
				return withRunId(sanitizedResult)
			}
			const rewrittenMessage =
				(await rewriteCapabilitySecretError({
					error: result.error,
					env,
					callerContext,
				})) ??
				rewriteUnboundRuntimeHelperError({
					error: result.error,
					modules: hydratedModules,
					unboundHelperNames: unboundOptionalRuntimeHelperNames,
				})
			const finalResult = rewrittenMessage
				? {
						...sanitizedResult,
						error: secretRedactor.redactErrorMessage(rewrittenMessage),
					}
				: sanitizedResult
			await finishObservedRun({
				status: 'error',
				logs: finalResult.logs ?? [],
				error: finalResult.error,
			})
			await recordPackageExportUsage('error')
			return withRunId(finalResult)
		} catch (error) {
			if (!runRecordFinished) {
				await finishObservedRun({
					status: 'error',
					error,
				})
			}
			throw error
		}
	} catch (error) {
		if (!runRecordFinished) {
			await finishObservedRun({
				status: 'error',
				error,
			})
		}
		await recordPackageExportUsage('error')
		throw error
	}
}
/**
 * A guard-less access to an unbound optional `kody:runtime` helper (for
 * example `storage.sql(...)` in an execute call without a bound `storageId`)
 * throws a bare TypeError that gives the caller no path to self-correct.
 * Enrich the message so `getExecutionErrorDetails` can attach a structured
 * next step naming the unbound helper.
 */
function rewriteUnboundRuntimeHelperError(input: {
	error: unknown
	modules: WorkerLoaderModules
	unboundHelperNames: ReadonlySet<string>
}) {
	const message = getErrorMessage(input.error)
	const access = findUnboundRuntimeHelperAccess({
		errorMessage: message,
		modules: input.modules,
		unboundHelperNames: input.unboundHelperNames,
	})
	if (!access) return null
	return createUnboundRuntimeHelperMessage({
		originalMessage: message,
		helperName: access.helperName,
		reference: access.reference,
	})
}

async function rewriteCapabilitySecretError(input: {
	error: unknown
	env: Env
	callerContext: McpCallerContext
}) {
	const message = getErrorMessage(input.error)
	const capabilityMatch = message.match(
		/^Secret "([^"]+)" is not allowed for capability "([^"]+)"/,
	)
	if (!capabilityMatch?.[1] || !capabilityMatch?.[2]) return null
	const capabilityName = capabilityMatch[2]
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	// Only use the structured error message. Scanning the full wrapped execute
	// bundle (prelude + user code) via /Secret "…"/ false-positives on unrelated
	// string literals, comments, or prior-step text and inflates approval lists.
	const secretNames = collectSecretNamesFromCapabilityError(input.error)
	if (secretNames.length === 0) return null
	const normalizedStorageContext = normalizeStorageContext(
		input.callerContext.storageContext,
	)
	const missing = await findMissingCapabilityApprovals({
		env: input.env,
		userId,
		secretNames,
		capabilityName,
		storageContext: normalizedStorageContext,
		baseUrl: input.callerContext.baseUrl,
	})
	if (missing.length === 0) return null
	return createCapabilitySecretAccessDeniedBatchMessage(missing)
}

function collectSecretNamesFromCapabilityError(error: unknown) {
	const message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: ''
	const fromError = message ? parseSecretNamesFromMessage(message) : []
	return normalizeSecretNameList(fromError)
}

function parseSecretNamesFromMessage(message: string) {
	const matches = Array.from(message.matchAll(/Secret "([^"]+)"/g))
	return matches
		.map((match) => match[1])
		.filter((value): value is string => Boolean(value))
}

function normalizeSecretNameList(names: Array<string>) {
	return Array.from(
		new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
	).sort((left, right) => left.localeCompare(right))
}

const redactedSecretText = '[REDACTED SECRET]'

function createExecutionSecretRedactor() {
	const secretValues = new Set<string>()
	return {
		track(value: string) {
			if (value.length > 0) {
				secretValues.add(value)
			}
		},
		redactErrorMessage(value: string) {
			return redactSecretValuesInString(value, secretValues)
		},
		sanitizeExecuteResult(result: ExecuteResult): ExecuteResult {
			return {
				...result,
				result: redactUnknownSecretValues(result.result, secretValues),
				logs: Array.isArray(result.logs)
					? result.logs.map((entry) =>
							redactSecretValuesInString(entry, secretValues),
						)
					: result.logs,
				error: redactExecuteError(result.error, secretValues),
			}
		},
	}
}

function collectSecretInputValues(input: {
	schema: unknown
	value: unknown
	track?: (value: string) => void
}) {
	if (!input.track) return
	visitSecretInputValue(input.schema, input.value, input.track)
}

function visitSecretInputValue(
	schema: unknown,
	value: unknown,
	track: (value: string) => void,
) {
	if (typeof value === 'string' && isSecretInputSchema(schema)) {
		track(value)
		return
	}
	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema)
		if (!itemSchema) return
		for (const item of value) {
			visitSecretInputValue(itemSchema, item, track)
		}
		return
	}
	if (!isRecord(value)) return
	const propertySchemas = getSchemaProperties(schema)
	const additionalProperties = getAdditionalPropertiesSchema(schema)
	if (!propertySchemas && !additionalProperties) return
	for (const [key, entryValue] of Object.entries(value)) {
		const entrySchema = propertySchemas?.[key] ?? additionalProperties
		if (!entrySchema) continue
		visitSecretInputValue(entrySchema, entryValue, track)
	}
}

function redactUnknownSecretValues(
	value: unknown,
	secretValues: ReadonlySet<string>,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (secretValues.size === 0) return value
	if (typeof value === 'string') {
		return redactSecretValuesInString(value, secretValues)
	}
	if (value instanceof Error) {
		const existing = seen.get(value)
		if (existing) return existing
		const next = new Error(
			redactSecretValuesInString(value.message, secretValues),
			value.cause !== undefined ? { cause: undefined } : undefined,
		)
		seen.set(value, next)
		if (value.cause !== undefined) {
			next.cause = redactUnknownSecretValues(value.cause, secretValues, seen)
		}
		next.name = value.name
		if (value.stack) {
			next.stack = redactSecretValuesInString(value.stack, secretValues)
		}
		return next
	}
	if (Array.isArray(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Array<unknown> = []
		seen.set(value, next)
		for (const entry of value) {
			next.push(redactUnknownSecretValues(entry, secretValues, seen))
		}
		return next
	}
	if (isRecord(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Record<string, unknown> = {}
		seen.set(value, next)
		for (const [key, entry] of Object.entries(value)) {
			const redactedKey = redactSecretValuesInString(key, secretValues)
			next[redactedKey] = redactUnknownSecretValues(entry, secretValues, seen)
		}
		return next
	}
	return value
}

function redactExecuteError(
	error: ExecuteResult['error'],
	secretValues: ReadonlySet<string>,
): ExecuteResult['error'] {
	if (error === undefined) return undefined
	const redacted = redactUnknownSecretValues(error, secretValues)
	if (typeof redacted === 'string') return redacted
	if (redacted instanceof Error) return redacted.message
	return String(redacted)
}

function redactSecretValuesInString(
	value: string,
	secretValues: ReadonlySet<string>,
) {
	if (secretValues.size === 0 || value.length === 0) return value
	let nextValue = value
	for (const secretValue of [...secretValues].sort(
		(left, right) => right.length - left.length,
	)) {
		nextValue = nextValue.replaceAll(secretValue, redactedSecretText)
	}
	return nextValue
}

function normalizeStorageContext(
	storageContext: McpCallerContext['storageContext'] | null,
) {
	if (!storageContext) return null
	return {
		sessionId: storageContext.sessionId ?? null,
		appId: storageContext.appId ?? null,
		packageId: storageContext.packageId ?? null,
		storageId: storageContext.storageId ?? null,
	}
}

async function findMissingCapabilityApprovals(input: {
	env: Env
	userId: string
	secretNames: Array<string>
	capabilityName: string
	storageContext: McpCallerContext['storageContext'] | null
	baseUrl: string
}) {
	const normalizedStorageContext = normalizeStorageContext(input.storageContext)
	const entries = await Promise.all(
		input.secretNames.map(async (name) => {
			const resolved = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name,
				storageContext: normalizedStorageContext,
			})
			if (!resolved.found) return null
			if (resolved.allowedCapabilities.includes(input.capabilityName)) {
				return null
			}
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: input.baseUrl,
				name,
				scope: resolved.scope ?? 'user',
				capabilityName: input.capabilityName,
				storageContext: normalizedStorageContext,
			})
			return {
				secretName: name,
				capabilityName: input.capabilityName,
				approvalUrl,
			}
		}),
	)
	return entries.filter(
		(entry): entry is NonNullable<typeof entry> => entry != null,
	)
}
