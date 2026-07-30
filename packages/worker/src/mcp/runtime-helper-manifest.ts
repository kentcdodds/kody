import {
	resolveProvider,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	createExecuteHelperPrelude,
	getExecuteHelperCapabilityNames,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	createPackageStorageHelperPrelude,
	createPackageStorageKodyTools,
	createStorageKodyTools,
	createStorageHelperPrelude,
} from '#worker/storage-runner.ts'
import { type PackageWorkflowCreateInput } from '#worker/package-runtime/package-workflows.ts'

export type AdditionalKodyTools = Record<
	string,
	(args: unknown) => Promise<unknown>
>

export type StorageToolOptions = {
	userId: string
	storageId: string
	writable: boolean
}

export type PackageStorageToolOptions = {
	/**
	 * Saved-package UUIDs whose buckets `packageStorage()` may reach in this
	 * run. Must come from bundler-controlled provenance only (own package
	 * context plus recorded bundle dependency metadata); see
	 * `collectPackageStorageGrantIds`.
	 */
	grantedPackageIds: ReadonlySet<string>
}

export type ServiceToolOptions = {
	getStatus: () => Promise<unknown>
	shouldStop: () => Promise<boolean>
	setAlarm: (runAt: Date) => Promise<{ ok: true; scheduled_at: string }>
	clearAlarm: () => Promise<{ ok: true }>
}

export type PackageSecretToolOptions = {
	get: (alias: string) => Promise<string>
	has: (alias: string) => Promise<boolean>
}

export type EmailToolOptions = {
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

type RuntimeHelperAbsentValue = 'undefined' | 'null'

type RuntimeHelperRuntimeBinding = {
	runtimeName: string
	variableName?: string
	absentValue: RuntimeHelperAbsentValue
}

export type RuntimeHelperManifestContext = {
	env: Env
	callerContext: McpCallerContext
	capabilityMap: Record<string, unknown>
	provider?: ResolvedProvider | undefined
	storageTools?: StorageToolOptions | undefined
	packageStorageTools?: PackageStorageToolOptions | undefined
	serviceTools?: ServiceToolOptions | undefined
	packageSecretTools?: PackageSecretToolOptions | undefined
	emailTools?: EmailToolOptions | undefined
	workflowTools?: PackageWorkflowTools | undefined
	packageInvokeTools?: PackageInvokeTools | undefined
	packageEventTools?: PackageEventTools | undefined
}

type RuntimeHelperManifestEntry = {
	runtimeName: string
	runtimeBindings: Array<RuntimeHelperRuntimeBinding>
	unboundNames: Array<string>
	isBound: (context: RuntimeHelperManifestContext) => boolean
	createPrelude?: (context: RuntimeHelperManifestContext) => string
	createKodyTools?: (
		context: RuntimeHelperManifestContext,
	) => AdditionalKodyTools | Promise<AdditionalKodyTools>
	extraProviders?: (
		context: RuntimeHelperManifestContext,
	) => Array<ResolvedProvider>
}

export type RuntimeHelperKodyToolSet = {
	runtimeName: string
	tools: AdditionalKodyTools
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
	// `check` and `invokeChecked` are deprecated widen-phase shims: they keep
	// working but warn once per run naming the replacement, because agents
	// learn the current contract from logs and error text.
	return `
const packages = (() => {
  const warned = new Set();
  const warnOnce = (name, message) => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(message);
  };
  return {
    check: async (input) => {
      warnOnce('check', '[deprecated] packages.check: packages.invoke always contract-checks before invoking, so call packages.invoke({ kodyId, exportName, params }) directly (add idempotencyKey only when you need exactly-once).');
      return await ${packageInvokeRuntimeBridgeProviderName}.check(input ?? {});
    },
    invoke: async (input) => await ${packageInvokeRuntimeBridgeProviderName}.invoke(input ?? {}),
    invokeChecked: async (input) => {
      warnOnce('invokeChecked', '[deprecated] packages.invokeChecked: use a static import (import fn from "kody:@scope/pkg/export") when the target package is known at write time, or packages.invoke({ kodyId, exportName, params }) for dynamic targets (add idempotencyKey only when you need exactly-once).');
      return await ${packageInvokeRuntimeBridgeProviderName}.invokeChecked(input ?? {});
    },
  };
})();
	`.trim()
}

function createEventsHelperPrelude() {
	return `
const events = {
  dispatch: async (input) => await ${packageEventRuntimeBridgeProviderName}.dispatch(input ?? {}),
};
	`.trim()
}

function createServiceKodyTools(
	serviceTools: ServiceToolOptions,
): AdditionalKodyTools {
	return {
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
				throw new Error('service.setAlarm requires a valid runAt ISO string.')
			}
			return await serviceTools.setAlarm(runAt)
		},
		service_clear_alarm: async () => await serviceTools.clearAlarm(),
	}
}

function createPackageSecretKodyTools(
	packageSecretTools: PackageSecretToolOptions,
): AdditionalKodyTools {
	return {
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
}

function createEmailKodyTools(
	context: RuntimeHelperManifestContext,
	emailTools: EmailToolOptions,
): AdditionalKodyTools {
	return {
		...(context.capabilityMap.email_message_get
			? {}
			: {
					email_message_get: async (args: unknown) => {
						const messageId =
							typeof args === 'object' && args !== null && 'message_id' in args
								? String((args as { message_id: unknown }).message_id ?? '')
								: ''
						return await emailTools.getMessage(messageId)
					},
				}),
		...(context.capabilityMap.email_attachment_get
			? {}
			: {
					email_attachment_get: async (args: unknown) => {
						const attachmentId =
							typeof args === 'object' &&
							args !== null &&
							'attachment_id' in args
								? String(
										(args as { attachment_id: unknown }).attachment_id ?? '',
									)
								: ''
						return await emailTools.getAttachment(attachmentId)
					},
				}),
	}
}

function createWorkflowKodyTools(
	workflowTools: PackageWorkflowTools,
): AdditionalKodyTools {
	return {
		package_workflow_create: async (args: unknown) =>
			await workflowTools.create(args as PackageWorkflowCreateInput),
	}
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

const runtimeHelperManifest: Array<RuntimeHelperManifestEntry> = [
	{
		runtimeName: 'execute',
		runtimeBindings: [
			{ runtimeName: 'refreshAccessToken', absentValue: 'undefined' },
			{ runtimeName: 'createAuthenticatedFetch', absentValue: 'undefined' },
			{ runtimeName: 'secretHeaders', absentValue: 'undefined' },
			{ runtimeName: 'oauthClientCredentials', absentValue: 'undefined' },
		],
		unboundNames: [
			'refreshAccessToken',
			'createAuthenticatedFetch',
			'secretHeaders',
			'oauthClientCredentials',
		],
		isBound: (context) =>
			context.provider
				? providerExposesExecuteHelperCapabilities(context.provider)
				: false,
		createPrelude: () => createExecuteHelperPrelude(),
	},
	{
		runtimeName: 'storage',
		runtimeBindings: [{ runtimeName: 'storage', absentValue: 'undefined' }],
		unboundNames: ['storage'],
		isBound: (context) => Boolean(context.storageTools),
		createPrelude: (context) => {
			const storageTools = context.storageTools
			if (!storageTools) return ''
			return createStorageHelperPrelude({
				storageId: storageTools.storageId,
				writable: storageTools.writable,
			})
		},
		createKodyTools: async (context) => {
			const storageTools = context.storageTools
			if (!storageTools) return {}
			return await createStorageKodyTools({
				env: context.env,
				userId: context.callerContext.user?.userId ?? '',
				email: context.callerContext.user?.email,
				storageId: storageTools.storageId,
				writable: storageTools.writable,
			})
		},
	},
	{
		runtimeName: 'packageStorage',
		runtimeBindings: [
			{
				runtimeName: '__kodyPackageStorage',
				absentValue: 'undefined',
			},
		],
		unboundNames: [],
		isBound: (context) => Boolean(context.packageStorageTools),
		createPrelude: () => createPackageStorageHelperPrelude(),
		createKodyTools: (context) => {
			const packageStorageTools = context.packageStorageTools
			const packageStorageUserId = context.callerContext.user?.userId ?? ''
			if (!packageStorageTools || !packageStorageUserId) return {}
			return createPackageStorageKodyTools({
				env: context.env,
				userId: packageStorageUserId,
				email: context.callerContext.user?.email,
				grantedPackageIds: packageStorageTools.grantedPackageIds,
			})
		},
	},
	{
		runtimeName: 'service',
		runtimeBindings: [{ runtimeName: 'service', absentValue: 'null' }],
		unboundNames: ['service'],
		isBound: (context) => Boolean(context.serviceTools),
		createPrelude: () => createServiceHelperPrelude(),
		createKodyTools: (context) =>
			context.serviceTools ? createServiceKodyTools(context.serviceTools) : {},
	},
	{
		runtimeName: 'packageSecrets',
		runtimeBindings: [{ runtimeName: 'packageSecrets', absentValue: 'null' }],
		unboundNames: ['packageSecrets'],
		isBound: (context) => Boolean(context.packageSecretTools),
		createPrelude: () => createPackageSecretsHelperPrelude(),
		createKodyTools: (context) =>
			context.packageSecretTools
				? createPackageSecretKodyTools(context.packageSecretTools)
				: {},
	},
	{
		runtimeName: 'email',
		runtimeBindings: [{ runtimeName: 'email', absentValue: 'null' }],
		unboundNames: ['email'],
		isBound: (context) => Boolean(context.emailTools),
		createPrelude: () => createEmailHelperPrelude(),
		createKodyTools: (context) =>
			context.emailTools
				? createEmailKodyTools(context, context.emailTools)
				: {},
	},
	{
		runtimeName: 'workflows',
		runtimeBindings: [{ runtimeName: 'workflows', absentValue: 'null' }],
		unboundNames: ['workflows'],
		isBound: (context) => Boolean(context.workflowTools),
		createPrelude: () => createWorkflowsHelperPrelude(),
		createKodyTools: (context) =>
			context.workflowTools
				? createWorkflowKodyTools(context.workflowTools)
				: {},
	},
	{
		runtimeName: 'packages',
		runtimeBindings: [{ runtimeName: 'packages', absentValue: 'null' }],
		unboundNames: ['packages'],
		isBound: (context) => Boolean(context.packageInvokeTools),
		createPrelude: () => createPackagesHelperPrelude(),
		extraProviders: (context) =>
			context.packageInvokeTools
				? [createPackageInvokeRuntimeBridgeProvider(context.packageInvokeTools)]
				: [],
	},
	{
		runtimeName: 'events',
		runtimeBindings: [{ runtimeName: 'events', absentValue: 'null' }],
		unboundNames: ['events'],
		isBound: (context) => Boolean(context.packageEventTools),
		createPrelude: () => createEventsHelperPrelude(),
		extraProviders: (context) =>
			context.packageEventTools
				? [createPackageEventRuntimeBridgeProvider(context.packageEventTools)]
				: [],
	},
]

const runtimeHelperRuntimeBindingOrder: Array<string> = [
	'storage',
	'packageStorage',
	'execute',
	'service',
	'packageSecrets',
	'email',
	'workflows',
	'packages',
	'events',
]

function runtimeHelperRuntimeBindings() {
	const entriesByName = new Map(
		runtimeHelperManifest.map((entry) => [entry.runtimeName, entry]),
	)
	return runtimeHelperRuntimeBindingOrder.flatMap((runtimeName) => {
		const entry = entriesByName.get(runtimeName)
		return entry?.runtimeBindings ?? []
	})
}

export async function createRuntimeHelperKodyToolSets(
	context: RuntimeHelperManifestContext,
): Promise<Array<RuntimeHelperKodyToolSet>> {
	const toolSets: Array<RuntimeHelperKodyToolSet> = []
	for (const entry of runtimeHelperManifest) {
		if (!entry.createKodyTools) continue
		const tools = entry.isBound(context)
			? await entry.createKodyTools(context)
			: {}
		toolSets.push({
			runtimeName: entry.runtimeName,
			tools,
		})
	}
	return toolSets
}

export function createRuntimeHelperPreludes(
	context: RuntimeHelperManifestContext,
): Array<string> {
	return runtimeHelperManifest.flatMap((entry) => {
		if (!entry.createPrelude || !entry.isBound(context)) return []
		return [entry.createPrelude(context)]
	})
}

export function createRuntimeHelperRuntimePropertySource() {
	return runtimeHelperRuntimeBindings()
		.map((binding) => {
			const variableName = binding.variableName ?? binding.runtimeName
			return `    ${binding.runtimeName}: typeof ${variableName} === 'undefined' ? ${binding.absentValue} : ${variableName},`
		})
		.join('\n')
}

export function createUnboundOptionalRuntimeHelperNames(
	context: RuntimeHelperManifestContext,
) {
	return new Set(
		runtimeHelperManifest.flatMap((entry) =>
			entry.isBound(context) ? [] : entry.unboundNames,
		),
	)
}

export function createRuntimeHelperExtraProviders(
	context: RuntimeHelperManifestContext,
) {
	return runtimeHelperManifest.flatMap((entry) =>
		entry.extraProviders && entry.isBound(context)
			? entry.extraProviders(context)
			: [],
	)
}
