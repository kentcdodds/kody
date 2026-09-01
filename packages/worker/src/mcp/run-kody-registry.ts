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
import {
	createExecuteExecutor,
	createNamedExecutionError,
} from '#mcp/executor.ts'
import { type RawFetchHostSink } from '#mcp/raw-fetch-host-nudge.ts'
import { resolvePackageMountedSecret } from '#mcp/secrets/package-access.ts'
import {
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
} from '#mcp/secrets/execution-secret-redactor.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import { createRemovedValueWriteError } from '#mcp/capabilities/values/shared.ts'
import {
	type KodyMcpServerMetadata,
	type KodyResolvedProvider,
} from '#mcp/kody-remote-types.ts'
import { assertPersonOwnedPackageMayNotRunPlatformDependencies } from '#worker/package-registry/platform-package-policy.ts'
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
import { runWithTransientDurableObjectResetRetry } from '#worker/durable-object-reset-retry.ts'
import { evaluationHasHostMediatedSideEffects } from '#mcp/evaluation-side-effects.ts'
import { isTransientJobExecutionError } from '#worker/jobs/execution-safety.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { shouldRecordExecuteUsageForRun } from '#worker/usage/execute-usage-surface.ts'
import { createDynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { type BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { createPackageStaticCallMeterTools } from '#worker/usage/package-static-call-usage.ts'
import { recordAgentPackageConversationUses } from '#worker/usage/agent-package-conversation-uses.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	formatMcpServerUnavailableMessage,
	getMcpServerStatus,
} from '#worker/mcp-client/status.ts'
import { mcpServerKodyName } from '#worker/mcp-client/mcp-domain-id.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import {
	reportExecutePhaseProgress,
	type McpReportProgress,
} from '#mcp/progress.ts'
import {
	firstCapabilityDispatchWarnTag,
	shouldWarnFirstCapabilityDispatch,
} from './first-capability-dispatch.ts'

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
	PackageInvokeOptions,
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
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
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
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
		packageSecretTools?: PackageSecretToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
		reportProgress?: McpReportProgress
		waitUntil?: (promise: Promise<unknown>) => void
	},
): Promise<{
	tools: AdditionalKodyTools
	mcpServers: Array<KodyMcpServerMetadata>
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
	const mcpServers = await buildKodyMcpServerMetadata({
		env,
		callerContext,
		capabilityMap,
	})
	const additionalTools = options?.additionalTools ?? {}
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
					const toolArgs = (args ?? {}) as Record<string, unknown>
					trackPersistedSecretInputValues(
						capabilityName,
						toolArgs,
						options?.trackSecretInputValue,
					)
					return await capability.handler(toolArgs, {
						env,
						callerContext,
						...(options?.reportProgress
							? { reportProgress: options.reportProgress }
							: {}),
						...(options?.waitUntil ? { waitUntil: options.waitUntil } : {}),
					})
				} finally {
					if (shouldSampleFirstDispatch) {
						const durationMs = Date.now() - dispatchStartedAtMs
						if (shouldWarnFirstCapabilityDispatch(durationMs)) {
							console.warn(firstCapabilityDispatchWarnTag, {
								capabilityName,
								durationMs,
							})
						}
					}
				}
			},
		]),
	) as AdditionalKodyTools
	if (!capabilityKodyTools.value_set) {
		capabilityKodyTools.value_set = async () => {
			throw createRemovedValueWriteError()
		}
	}
	const runtimeHelperKodyToolSets = await createRuntimeHelperKodyToolSets({
		env,
		callerContext,
		capabilityMap,
		packageStorageTools: options?.packageStorageTools,
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
		mcpServers,
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
		const refs = await listVisibleEnabledMcpServerRefsCached({
			env: input.env,
			userId,
			packageId: input.callerContext.storageContext?.packageId,
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

export async function buildKodyProvider(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
		packageSecretTools?: PackageSecretToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
		reportProgress?: McpReportProgress
		waitUntil?: (promise: Promise<unknown>) => void
	},
): Promise<ResolvedProvider> {
	const { tools, mcpServers } = await buildKodyToolContext(
		env,
		callerContext,
		options,
	)
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
		kodyMcpServers: mcpServers,
	}) satisfies KodyResolvedProvider
}

export async function runModuleWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalKodyTools
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
		/**
		 * Optional MCP progress reporter (from `_meta.progressToken`). Emits
		 * human-friendly phase messages aligned with `serverTiming` names.
		 */
		reportProgress?: McpReportProgress
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<{ name: string; durationMs: number }>
	}
> {
	const userId = callerContext.user?.userId ?? ''
	const serverTiming: Array<{ name: string; durationMs: number }> = []
	const reportProgress = options?.reportProgress
	await reportExecutePhaseProgress(reportProgress, 'bundle')
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
			reportProgress,
			waitUntil: options?.waitUntil,
		},
	)
	// Sub-phases (hydrate → provider-assembly → sandbox) report inside the
	// bundled run so progress stays monotonic. `run` is only the enclosing
	// serverTiming wall-clock span, not a client progress step.
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
		// Platform-scope (built-in) dependencies run in the caller's runtime
		// but stay stateless there: granting the platform package UUID would
		// open an empty caller-local bucket, never the platform account's
		// data, so `packageStorage()` fails closed inside live platform code.
		if (dependency.packageId && dependency.platformOwned !== true) {
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
		packageContext?: PackageContextOptions
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
		reportProgress?: McpReportProgress
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<ExecuteServerTimingEntry>
	}
> {
	const runServerTiming: Array<ExecuteServerTimingEntry> = []
	const secretRedactor = createExecutionSecretRedactor()
	const reportProgress = options?.reportProgress
	const normalizedStorageContext = normalizeStorageContext(
		callerContext.storageContext ?? null,
	)
	const runRecordContext = options?.runRecord
		? {
				...options.runRecord,
				storageId:
					options.runRecord.storageId ??
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
	const callerOwnsScheduledJobRun =
		options?.runRecordHandle != null &&
		(options.runRecord?.surface === 'job' ||
			options.runRecordHandle.context.surface === 'job')
	let exposeRunId = runRecordHandle?.persistence === 'eager'
	let capturedLogs: Array<string> | undefined
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
		await reportExecutePhaseProgress(reportProgress, 'hydrate')
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
		await reportExecutePhaseProgress(reportProgress, 'provider-assembly')
		const providerAssemblyStartedAtMs = Date.now()
		const runningPackageId = options?.packageContext?.packageId?.trim()
		const runningUserId = callerContext.user?.userId
		if (runningPackageId && runningUserId) {
			await assertPersonOwnedPackageMayNotRunPlatformDependencies({
				db: env.APP_DB,
				userId: runningUserId,
				packageId: runningPackageId,
				dependencies: bundle.dependencies ?? [],
			})
		}
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
			recordExecuteUsage: shouldRecordExecuteUsageForRun({
				surface: options?.runRecord?.surface,
				hasPackageContext: Boolean(options?.packageContext),
			}),
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
			packageStorageTools,
			packageSecretTools,
			emailTools: options?.emailTools,
			workflowTools,
			skipCapabilityRegistry: options?.skipCapabilityRegistry,
			capabilityRegistry: options?.capabilityRegistry,
			reportProgress,
			waitUntil: options?.waitUntil,
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
			packageStorageTools,
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
			await reportExecutePhaseProgress(reportProgress, 'sandbox')
			const sandboxStartedAtMs = Date.now()
			let result: ExecuteResult
			try {
				result = await runWithTransientDurableObjectResetRetry({
					operation: () => executor.execute(wrapped, providers),
					retryableResultError: (executeResult) => executeResult.error ?? null,
					shouldRetry: ({ result: executeResult }) =>
						!evaluationHasHostMediatedSideEffects(
							executeResult?.hostMediatedSideEffects,
						),
					signal: options?.signal,
					onRetry: ({ attempt, nextDelayMs, error }) => {
						console.warn(
							JSON.stringify({
								message:
									'runBundledModuleWithRegistry transient Durable Object reset',
								attempt,
								nextDelayMs,
								errorMessage: getErrorMessage(error),
							}),
						)
					},
				})
			} finally {
				const sandboxMs = Date.now() - sandboxStartedAtMs
				runServerTiming.push({
					name: 'sandbox',
					durationMs: sandboxMs,
				})
				if (runRecordHandle) {
					runRecordHandle.context = {
						...runRecordHandle.context,
						metadata: {
							...runRecordHandle.context.metadata,
							sandboxMs,
						},
					}
				}
			}
			const sanitizedResult = sanitizeExecuteResult(result, secretRedactor)
			capturedLogs = sanitizedResult.logs
			if (!result.error) {
				await finishObservedRun({
					status: 'success',
					logs: sanitizedResult.logs ?? [],
					result: sanitizedResult.result,
				})
				await recordPackageExportUsage('success')
				return withRunId(sanitizedResult)
			}
			const rewrittenMessage = rewriteUnboundRuntimeHelperError({
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
			if (
				callerOwnsScheduledJobRun &&
				isTransientJobExecutionError(finalResult.error)
			) {
				// Leave the claimed run `running` so the job scheduler can
				// abandon it and retry the same scheduledFor. Finishing as
				// error would make the idempotency replay permanent — the
				// next claim would replay the terminal row instead of
				// retrying the occurrence (D1 blips, DO isolate resets,
				// storage-estimate misses).
				return withRunId(finalResult)
			}
			await finishObservedRun({
				status: 'error',
				logs: finalResult.logs ?? [],
				error: createNamedExecutionError(finalResult.error),
			})
			await recordPackageExportUsage('error')
			return withRunId(finalResult)
		} catch (error) {
			if (
				!runRecordFinished &&
				callerOwnsScheduledJobRun &&
				isTransientJobExecutionError(error)
			) {
				throw error
			}
			if (!runRecordFinished) {
				await finishObservedRun({
					status: 'error',
					logs: capturedLogs,
					error,
				})
			}
			throw error
		}
	} catch (error) {
		if (
			!runRecordFinished &&
			callerOwnsScheduledJobRun &&
			isTransientJobExecutionError(error)
		) {
			throw error
		}
		if (!runRecordFinished) {
			await finishObservedRun({
				status: 'error',
				logs: capturedLogs,
				error,
			})
		}
		await recordPackageExportUsage('error')
		throw error
	}
}
/**
 * A guard-less access to an unbound optional `kody:runtime` helper (for
 * example `email.getMessage(...)` outside an email-triggered run)
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

function trackPersistedSecretInputValues(
	capabilityName: string,
	args: Record<string, unknown>,
	track?: (value: string) => void,
) {
	if (!track) return
	if (capabilityName === 'secretSet' && typeof args.value === 'string') {
		track(args.value)
		return
	}
	if (capabilityName === 'secretSetMany' && Array.isArray(args.secrets)) {
		for (const entry of args.secrets) {
			if (isRecord(entry) && typeof entry.value === 'string') {
				track(entry.value)
			}
		}
	}
}

function sanitizeExecuteResult(
	result: ExecuteResult,
	secretRedactor: ExecutionSecretRedactor,
): ExecuteResult {
	return {
		...result,
		result: secretRedactor.redactUnknown(result.result),
		logs: Array.isArray(result.logs)
			? result.logs.map((entry) => secretRedactor.redactErrorMessage(entry))
			: result.logs,
		error: redactExecuteError(result.error, secretRedactor),
	}
}

function redactExecuteError(
	error: ExecuteResult['error'],
	secretRedactor: ExecutionSecretRedactor,
): ExecuteResult['error'] {
	if (error === undefined) return undefined
	const redacted = secretRedactor.redactUnknown(error)
	if (typeof redacted === 'string') return redacted
	if (redacted instanceof Error) return redacted.message
	return String(redacted)
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
