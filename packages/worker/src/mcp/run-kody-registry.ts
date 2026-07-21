import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
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
	isRecord,
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
	createExecuteHelperPrelude,
	getExecuteHelperCapabilityNames,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	buildKodyModuleBundle,
	hydrateKodyRuntimeModules,
} from '#worker/package-runtime/module-graph.ts'
import {
	createUnboundRuntimeHelperMessage,
	findUnboundRuntimeHelperAccess,
} from '#worker/package-runtime/unbound-runtime-helpers.ts'
import {
	beginPackageRuntimeRun,
	finishPackageRuntimeRun,
	type PackageRuntimeDebugContext,
} from '#worker/package-runtime/package-runtime-debug.ts'
import {
	createDynamicCallableWorkflow,
	type PackageWorkflowCreateInput,
} from '#worker/package-runtime/package-workflows.ts'
import {
	createPackageStorageHelperPrelude,
	createPackageStorageKodyTools,
	createStorageKodyTools,
	createStorageHelperPrelude,
} from '#worker/storage-runner.ts'
import { type BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
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
import { listEnabledMcpServerRefs } from '#worker/mcp-client/settings-service.ts'

type AdditionalKodyTools = Record<string, (args: unknown) => Promise<unknown>>

type StorageToolOptions = {
	userId: string
	storageId: string
	writable: boolean
}

type PackageStorageToolOptions = {
	/**
	 * Saved-package UUIDs whose buckets `packageStorage()` may reach in this
	 * run. Must come from bundler-controlled provenance only (own package
	 * context plus recorded bundle dependency metadata); see
	 * `collectPackageStorageGrantIds`.
	 */
	grantedPackageIds: ReadonlySet<string>
}

type ServiceToolOptions = {
	getStatus: () => Promise<unknown>
	shouldStop: () => Promise<boolean>
	setAlarm: (runAt: Date) => Promise<{ ok: true; scheduled_at: string }>
	clearAlarm: () => Promise<{ ok: true }>
}

type PackageSecretToolOptions = {
	get: (alias: string) => Promise<string>
	has: (alias: string) => Promise<boolean>
}

type EmailToolOptions = {
	getMessage: (messageId: string) => Promise<unknown>
	getAttachment: (attachmentId: string) => Promise<unknown>
}

export type PackageInvokeInput = Record<string, unknown>

export type PackageInvokeNormalizedInput = {
	kodyId?: string
	packageId?: string
	exportName: string
	params?: Record<string, unknown>
	idempotencyKey?: string
	topic?: string
}

export type PackageInvokeContract = {
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string | null
	exportName: string
	runtimeTarget: string | null
	description?: string | null
	typeDefinition?: string | null
	warnings: Array<string>
}

export type PackageInvokeCheckResult =
	| {
			ok: true
			invoke: PackageInvokeNormalizedInput
			contract: PackageInvokeContract
	  }
	| {
			ok: false
			message: string
			problems: Array<string>
			contract?: Partial<PackageInvokeContract>
	  }

export type PackageInvokeTools = {
	invoke: (input: PackageInvokeInput) => Promise<unknown>
	check: (input: PackageInvokeInput) => Promise<PackageInvokeCheckResult>
	invokeChecked: (input: PackageInvokeInput) => Promise<unknown>
}

export type PackageEventDispatchInput = {
	topic?: unknown
	idempotencyKey?: unknown
	payload?: unknown
}

export type PackageEventTools = {
	dispatch: (input: PackageEventDispatchInput) => Promise<unknown>
}

export type PackageWorkflowTools = {
	create: (input: PackageWorkflowCreateInput) => Promise<unknown>
}

export type PackageContextOptions = {
	packageId: string
	kodyId: string
	sourceId?: string | null
} | null

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

function createServiceHelperPrelude() {
	return `
const service = {
  getStatus: async () => await kody.service_get_status({}),
  shouldStop: async () => {
    const result = await kody.service_should_stop({});
    return result?.shouldStop === true;
  },
  setAlarm: async (runAt) => {
    const normalizedRunAt =
      runAt instanceof Date ? runAt.toISOString() : String(runAt ?? '');
    return await kody.service_set_alarm({ runAt: normalizedRunAt });
  },
  clearAlarm: async () => await kody.service_clear_alarm({}),
};
	`.trim()
}

function createPackageSecretsHelperPrelude() {
	return `
const packageSecrets = {
  get: async (alias) => {
    const normalizedAlias = typeof alias === 'string' ? alias.trim() : '';
    if (!normalizedAlias) {
      throw new Error('packageSecrets.get requires a non-empty alias.')
    }
    const result = await kody.package_secret_get({ alias: normalizedAlias });
    return typeof result?.value === 'string' ? result.value : '';
  },
  has: async (alias) => {
    const normalizedAlias = typeof alias === 'string' ? alias.trim() : '';
    if (!normalizedAlias) {
      throw new Error('packageSecrets.has requires a non-empty alias.')
    }
    const result = await kody.package_secret_has({ alias: normalizedAlias });
    return result?.has === true;
  },
};
	`.trim()
}

function createEmailHelperPrelude() {
	return `
const email = {
  getMessage: async (messageId) => {
    const normalizedMessageId =
      typeof messageId === 'string' ? messageId.trim() : '';
    if (!normalizedMessageId) {
      throw new Error('email.getMessage requires a non-empty message id.')
    }
    return await kody.email_message_get({ message_id: normalizedMessageId });
  },
  getAttachment: async (attachmentId) => {
    const normalizedAttachmentId =
      typeof attachmentId === 'string' ? attachmentId.trim() : '';
    if (!normalizedAttachmentId) {
      throw new Error('email.getAttachment requires a non-empty attachment id.')
    }
    const result = await kody.email_attachment_get({
      attachment_id: normalizedAttachmentId,
    });
    if (!result || typeof result !== 'object') {
      return result;
    }
    if ('content_base64' in result) {
      return result;
    }
    return {
      ...result,
      content_base64:
        typeof result.data_base64 === 'string' ? result.data_base64 : null,
    };
  },
  reply: async (input) => await kody.email_reply(input ?? {}),
};
	`.trim()
}

function createWorkflowsHelperPrelude() {
	return `
const workflows = {
  create: async (input) => await kody.package_workflow_create(input ?? {}),
};
	`.trim()
}

const packageInvokeRuntimeBridgeProviderName =
	'__kodyPackageInvokeRuntimeBridge'
const packageEventRuntimeBridgeProviderName = '__kodyPackageEventRuntimeBridge'

function createPackagesHelperPrelude() {
	return `
const packages = {
  check: async (input) => await ${packageInvokeRuntimeBridgeProviderName}.check(input ?? {}),
  invoke: async (input) => await ${packageInvokeRuntimeBridgeProviderName}.invoke(input ?? {}),
  invokeChecked: async (input) => await ${packageInvokeRuntimeBridgeProviderName}.invokeChecked(input ?? {}),
};
	`.trim()
}

function createEventsHelperPrelude() {
	return `
const events = {
  dispatch: async (input) => await ${packageEventRuntimeBridgeProviderName}.dispatch(input ?? {}),
};
	`.trim()
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
				return capability.handler(resolvedArgs as Record<string, unknown>, {
					env,
					callerContext,
				})
			},
		]),
	) as AdditionalKodyTools
	const storageKodyTools: AdditionalKodyTools = storageTools
		? await createStorageKodyTools({
				env,
				userId: callerContext.user?.userId ?? '',
				email: callerContext.user?.email,
				storageId: storageTools.storageId,
				writable: storageTools.writable,
			})
		: {}
	assertNoCapabilityCollisions(capabilityMap, storageKodyTools)
	const packageStorageTools = options?.packageStorageTools
	const packageStorageUserId = callerContext.user?.userId ?? ''
	const packageStorageKodyTools: AdditionalKodyTools =
		packageStorageTools && packageStorageUserId
			? createPackageStorageKodyTools({
					env,
					userId: packageStorageUserId,
					email: callerContext.user?.email,
					grantedPackageIds: packageStorageTools.grantedPackageIds,
				})
			: {}
	assertNoCapabilityCollisions(capabilityMap, packageStorageKodyTools)
	const serviceTools = options?.serviceTools
	const serviceKodyTools: AdditionalKodyTools = serviceTools
		? {
				service_get_status: async () => await serviceTools.getStatus(),
				service_should_stop: async () => ({
					shouldStop: await serviceTools.shouldStop(),
				}),
				service_set_alarm: async (args: unknown) => {
					const payload =
						typeof args === 'object' && args !== null
							? (args as { runAt?: unknown })
							: {}
					const runAtValue = payload.runAt
					const runAtString =
						typeof runAtValue === 'string' ? runAtValue.trim() : ''
					if (!runAtString) {
						throw new Error('service.setAlarm requires a runAt ISO string.')
					}
					const runAt = new Date(runAtString)
					if (Number.isNaN(runAt.getTime())) {
						throw new Error(
							'service.setAlarm requires a valid runAt ISO string.',
						)
					}
					return await serviceTools.setAlarm(runAt)
				},
				service_clear_alarm: async () => await serviceTools.clearAlarm(),
			}
		: {}
	assertNoCapabilityCollisions(capabilityMap, serviceKodyTools)
	const packageSecretTools = options?.packageSecretTools
	const packageSecretKodyTools: AdditionalKodyTools = packageSecretTools
		? {
				package_secret_get: async (args: unknown) => {
					const alias =
						typeof args === 'object' && args !== null && 'alias' in args
							? String((args as { alias: unknown }).alias ?? '')
							: ''
					return {
						value: await packageSecretTools.get(alias),
					}
				},
				package_secret_has: async (args: unknown) => {
					const alias =
						typeof args === 'object' && args !== null && 'alias' in args
							? String((args as { alias: unknown }).alias ?? '')
							: ''
					return {
						has: await packageSecretTools.has(alias),
					}
				},
			}
		: {}
	assertNoCapabilityCollisions(capabilityMap, packageSecretKodyTools)
	const emailTools = options?.emailTools
	const emailKodyTools: AdditionalKodyTools = emailTools
		? {
				...(capabilityMap.email_message_get
					? {}
					: {
							email_message_get: async (args: unknown) => {
								const messageId =
									typeof args === 'object' &&
									args !== null &&
									'message_id' in args
										? String((args as { message_id: unknown }).message_id ?? '')
										: ''
								return await emailTools.getMessage(messageId)
							},
						}),
				...(capabilityMap.email_attachment_get
					? {}
					: {
							email_attachment_get: async (args: unknown) => {
								const attachmentId =
									typeof args === 'object' &&
									args !== null &&
									'attachment_id' in args
										? String(
												(args as { attachment_id: unknown }).attachment_id ??
													'',
											)
										: ''
								return await emailTools.getAttachment(attachmentId)
							},
						}),
			}
		: {}
	assertNoCapabilityCollisions(capabilityMap, emailKodyTools)
	const workflowTools = options?.workflowTools
	const workflowKodyTools: AdditionalKodyTools = workflowTools
		? {
				package_workflow_create: async (args: unknown) =>
					await workflowTools.create(args as PackageWorkflowCreateInput),
			}
		: {}
	assertNoCapabilityCollisions(capabilityMap, workflowKodyTools)
	return {
		tools: {
			...capabilityKodyTools,
			...storageKodyTools,
			...packageStorageKodyTools,
			...serviceKodyTools,
			...packageSecretKodyTools,
			...emailKodyTools,
			...workflowKodyTools,
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
		const refs = await listEnabledMcpServerRefs({
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

function createPackageInvokeRuntimeBridgeProvider(
	packageInvokeTools: PackageInvokeTools,
): ResolvedProvider {
	const provider: ToolProvider = {
		name: packageInvokeRuntimeBridgeProviderName,
		tools: {
			check: {
				execute: async (args: unknown) =>
					await packageInvokeTools.check((args ?? {}) as PackageInvokeInput),
			},
			invoke: {
				execute: async (args: unknown) =>
					await packageInvokeTools.invoke((args ?? {}) as PackageInvokeInput),
			},
			invokeChecked: {
				execute: async (args: unknown) =>
					await packageInvokeTools.invokeChecked(
						(args ?? {}) as PackageInvokeInput,
					),
			},
		},
	}
	return resolveProvider(provider)
}

function createPackageEventRuntimeBridgeProvider(
	packageEventTools: PackageEventTools,
): ResolvedProvider {
	const provider: ToolProvider = {
		name: packageEventRuntimeBridgeProviderName,
		tools: {
			dispatch: {
				execute: async (args: unknown) =>
					await packageEventTools.dispatch(
						(args ?? {}) as PackageEventDispatchInput,
					),
			},
		},
	}
	return resolveProvider(provider)
}

function providerExposesExecuteHelperCapabilities(provider: ResolvedProvider) {
	return getExecuteHelperCapabilityNames().every((name) => name in provider.fns)
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
		packageInvokeTools?: PackageInvokeTools
		packageEventTools?: PackageEventTools
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		/**
		 * When set (MCP public `execute` tool), static/dynamic `kody:@…`
		 * package deps are credited toward agent-facing package popularity.
		 */
		conversationId?: string | null
	},
): Promise<ExecuteResult> {
	const userId = callerContext.user?.userId ?? ''
	const bundled = await buildKodyModuleBundle({
		env,
		baseUrl: callerContext.baseUrl,
		userId,
		sourceFiles: {
			'entry.ts': code,
		},
		entryPoint: 'entry.ts',
		reuseCachedBundle: true,
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
	return runBundledModuleWithRegistry(
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
}

async function finishPackageRuntimeRunBestEffort(
	input: Parameters<typeof finishPackageRuntimeRun>[0],
) {
	try {
		await finishPackageRuntimeRun(input)
	} catch (error) {
		console.warn('package-runtime-debug-finish-unhandled', error)
	}
}

/**
 * `packageStorage()` grant set for one bundled run, from bundler/host
 * controlled provenance only: the run's own package context, the saved
 * packages recorded in the bundle's static dependency metadata, and the
 * published artifacts installed for literal dynamic package imports during
 * hydration. Sandbox-supplied strings never extend this set, which is what
 * keeps a malicious module from claiming another installed package's bucket.
 */
function collectPackageStorageGrantIds(input: {
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
		runtimeDebug?: PackageRuntimeDebugContext | null
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		conversationId?: string | null
	},
): Promise<ExecuteResult> {
	const secretRedactor = createExecutionSecretRedactor()
	const normalizedStorageContext = normalizeStorageContext(
		callerContext.storageContext ?? null,
	)
	const runtimeDebugContext = options?.runtimeDebug
		? {
				...options.runtimeDebug,
				storageId:
					options.runtimeDebug.storageId ??
					options.storageTools?.storageId ??
					normalizedStorageContext?.storageId ??
					null,
			}
		: null
	const runtimeDebugRun = await beginPackageRuntimeRun({
		env,
		userId: callerContext.user?.userId ?? null,
		context: runtimeDebugContext,
	})
	let runtimeDebugFinished = false
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
	try {
		// Hydration can install additional published-package sources (literal
		// dynamic `import("kody:@...")` targets); keep a reference so error
		// rewriting below scans the same module graph the sandbox executed.
		const { modules: hydratedModules, dynamicDependencyPackageIds } =
			await hydrateKodyRuntimeModules({
				env,
				baseUrl: callerContext.baseUrl,
				userId: callerContext.user?.userId ?? '',
				modules: bundle.modules,
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
		const grantedPackageStorageIds = collectPackageStorageGrantIds({
			packageContext: options?.packageContext ?? null,
			dependencies: bundle.dependencies ?? [],
			dynamicDependencyPackageIds,
		})
		const executor = createExecuteExecutor({
			env,
			exports: options?.executorExports ?? workerExports,
			timeoutMs: options?.executorTimeoutMs,
			gatewayProps: {
				baseUrl: callerContext.baseUrl,
				userId: callerContext.user?.userId ?? null,
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
		const provider = await buildKodyProvider(env, callerContext, {
			trackSecretInputValue: (value) => {
				secretRedactor.track(value)
			},
			additionalTools: options?.additionalTools,
			storageTools: options?.storageTools,
			packageStorageTools,
			serviceTools: options?.serviceTools,
			packageSecretTools: options?.packageContext
				? createPackageSecretTools({
						env,
						callerContext,
						packageId: options.packageContext.packageId,
					})
				: undefined,
			emailTools: options?.emailTools,
			workflowTools,
			skipCapabilityRegistry: options?.skipCapabilityRegistry,
			capabilityRegistry: options?.capabilityRegistry,
		})
		const storageHelperPrelude = options?.storageTools
			? createStorageHelperPrelude({
					storageId: options.storageTools.storageId,
					writable: options.storageTools.writable,
				})
			: ''
		const packageStorageHelperPrelude = packageStorageTools
			? createPackageStorageHelperPrelude()
			: ''
		const serviceHelperPrelude = options?.serviceTools
			? createServiceHelperPrelude()
			: ''
		const packageSecretsHelperPrelude = options?.packageContext
			? createPackageSecretsHelperPrelude()
			: ''
		const emailHelperPrelude = options?.emailTools
			? createEmailHelperPrelude()
			: ''
		const workflowsHelperPrelude = workflowTools
			? createWorkflowsHelperPrelude()
			: ''
		const packagesHelperPrelude = options?.packageInvokeTools
			? createPackagesHelperPrelude()
			: ''
		const eventsHelperPrelude = options?.packageEventTools
			? createEventsHelperPrelude()
			: ''
		const executeHelperPrelude = providerExposesExecuteHelperCapabilities(
			provider,
		)
			? createExecuteHelperPrelude()
			: ''
		// Mirrors the `__kodyRuntime` object below: a helper whose prelude is
		// omitted reaches the sandbox as `undefined` / `null`, so guard-less
		// access to it is what the unbound-helper error rewrite looks for.
		const unboundOptionalRuntimeHelperNames = new Set<string>([
			...(storageHelperPrelude ? [] : ['storage']),
			...(executeHelperPrelude
				? []
				: [
						'refreshAccessToken',
						'createAuthenticatedFetch',
						'secretHeaders',
						'oauthClientCredentials',
					]),
			...(serviceHelperPrelude ? [] : ['service']),
			...(packageSecretsHelperPrelude ? [] : ['packageSecrets']),
			...(emailHelperPrelude ? [] : ['email']),
			...(workflowsHelperPrelude ? [] : ['workflows']),
			...(packagesHelperPrelude ? [] : ['packages']),
			...(eventsHelperPrelude ? [] : ['events']),
		])
		const entrypointInputJson = JSON.stringify(params)
		const entrypointInputSource =
			entrypointInputJson === undefined ? 'undefined' : entrypointInputJson
		const wrapped = `async () => {
${executeHelperPrelude ? `${executeHelperPrelude}\n` : ''}
${storageHelperPrelude ? `${storageHelperPrelude}\n` : ''}
${packageStorageHelperPrelude ? `${packageStorageHelperPrelude}\n` : ''}
${serviceHelperPrelude ? `${serviceHelperPrelude}\n` : ''}
${packageSecretsHelperPrelude ? `${packageSecretsHelperPrelude}\n` : ''}
${emailHelperPrelude ? `${emailHelperPrelude}\n` : ''}
${workflowsHelperPrelude ? `${workflowsHelperPrelude}\n` : ''}
${packagesHelperPrelude ? `${packagesHelperPrelude}\n` : ''}
${eventsHelperPrelude ? `${eventsHelperPrelude}\n` : ''}
  const { AsyncLocalStorage: __KodyAsyncLocalStorage } = await import('node:async_hooks');
  const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
  const __kodyGlobal = globalThis;
  const __kodyRuntimeStorage =
    __kodyGlobal[__kodyRuntimeStorageSymbol] ??
    (__kodyGlobal[__kodyRuntimeStorageSymbol] = new __KodyAsyncLocalStorage());
  const __kodyRuntime = {
    kody,
    storage: typeof storage === 'undefined' ? undefined : storage,
    __kodyPackageStorage: typeof __kodyPackageStorage === 'undefined' ? undefined : __kodyPackageStorage,
    refreshAccessToken: typeof refreshAccessToken === 'undefined' ? undefined : refreshAccessToken,
    createAuthenticatedFetch: typeof createAuthenticatedFetch === 'undefined' ? undefined : createAuthenticatedFetch,
    secretHeaders: typeof secretHeaders === 'undefined' ? undefined : secretHeaders,
    oauthClientCredentials: typeof oauthClientCredentials === 'undefined' ? undefined : oauthClientCredentials,
    packageContext: ${JSON.stringify(options?.packageContext ?? null)},
    serviceContext: ${JSON.stringify(options?.serviceContext ?? null)},
    service: typeof service === 'undefined' ? null : service,
    packageSecrets: typeof packageSecrets === 'undefined' ? null : packageSecrets,
    email: typeof email === 'undefined' ? null : email,
    workflows: typeof workflows === 'undefined' ? null : workflows,
    packages: typeof packages === 'undefined' ? null : packages,
    events: typeof events === 'undefined' ? null : events,
  };
  return await __kodyRuntimeStorage.run(__kodyRuntime, async () => {
    const __kodyModule = await import(${JSON.stringify(`./${bundle.mainModule}`)});
    const __kodyEntrypoint = __kodyModule?.default;
    if (typeof __kodyEntrypoint !== 'function') {
      throw new Error('Kody execute modules must default export a function.');
    }
    return await __kodyEntrypoint(${entrypointInputSource});
  });
}`
		try {
			const providers: Array<ResolvedProvider> = [provider]
			if (options?.packageInvokeTools) {
				providers.push(
					createPackageInvokeRuntimeBridgeProvider(options.packageInvokeTools),
				)
			}
			if (options?.packageEventTools) {
				providers.push(
					createPackageEventRuntimeBridgeProvider(options.packageEventTools),
				)
			}
			const result = await executor.execute(wrapped, providers)
			const sanitizedResult = secretRedactor.sanitizeExecuteResult(result)
			if (!result.error) {
				await finishPackageRuntimeRunBestEffort({
					env,
					handle: runtimeDebugRun,
					status: 'success',
					logs: sanitizedResult.logs ?? [],
				})
				runtimeDebugFinished = true
				await recordPackageExportUsage('success')
				return sanitizedResult
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
			await finishPackageRuntimeRunBestEffort({
				env,
				handle: runtimeDebugRun,
				status: 'error',
				logs: finalResult.logs ?? [],
				error: finalResult.error,
			})
			runtimeDebugFinished = true
			await recordPackageExportUsage('error')
			return finalResult
		} catch (error) {
			if (!runtimeDebugFinished) {
				await finishPackageRuntimeRunBestEffort({
					env,
					handle: runtimeDebugRun,
					status: 'error',
					error,
				})
				runtimeDebugFinished = true
			}
			throw error
		}
	} catch (error) {
		if (!runtimeDebugFinished) {
			await finishPackageRuntimeRunBestEffort({
				env,
				handle: runtimeDebugRun,
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
