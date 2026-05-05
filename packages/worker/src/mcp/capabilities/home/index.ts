import {
	isRemoteConnectorTrusted,
	type RemoteConnectorRef,
} from '@kody-internal/shared/remote-connectors.ts'
import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { type CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import { createRemoteConnectorMcpClient } from '#worker/home/client.ts'
import {
	formatRemoteConnectorUnavailableMessage,
	getRemoteConnectorStatus,
} from '#worker/home/status.ts'
import {
	remoteConnectorCapabilityPrefix,
	remoteConnectorDomainId,
} from '#worker/remote-connector/remote-domain-id.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { type HomeConnectorSnapshot } from '#worker/home/types.ts'

type RemoteToolCapabilityBinding = {
	capabilityName: string
	kind: string
	instanceId: string
	mcpToolName: string
}

export type SynthesizedRemoteConnectorDomain = {
	domain: DomainSpec
	bindings: Record<string, RemoteToolCapabilityBinding>
}

function createCapabilityNameFromPrefix(prefix: string, toolName: string) {
	const safeTool = toolName
		.replaceAll(/[^\w]+/g, '_')
		.replaceAll(/_+/g, '_')
		.replace(/^_|_$/g, '')
	return `${prefix}_${safeTool}`
}

function buildKeywords(
	snapshot: HomeConnectorSnapshot,
	tool: HomeConnectorSnapshot['tools'][number],
	ref: RemoteConnectorRef,
	extraRoots: ReadonlyArray<string>,
) {
	const kind = (snapshot.connectorKind ?? ref.kind).trim().toLowerCase()
	const words = [
		...extraRoots,
		kind,
		'connector',
		'remote',
		tool.name,
		tool.title ?? '',
		tool.description ?? '',
		snapshot.connectorId,
		ref.instanceId,
	]
	return Array.from(
		new Set(
			words
				.join(' ')
				.toLowerCase()
				.match(/[a-z0-9_]+/g)
				?.filter(Boolean) ?? [],
		),
	)
}

function createCapabilityFromTool(input: {
	snapshot: HomeConnectorSnapshot
	tool: HomeConnectorSnapshot['tools'][number]
	ref: RemoteConnectorRef
	domainId: CapabilityDomain
	capabilityPrefix: string
	domainKeywordRoots: ReadonlyArray<string>
}): { capability: Capability; binding: RemoteToolCapabilityBinding } {
	const {
		snapshot,
		tool,
		ref,
		domainId,
		capabilityPrefix,
		domainKeywordRoots,
	} = input
	const capabilityName = createCapabilityNameFromPrefix(
		capabilityPrefix,
		tool.name,
	)
	const binding: RemoteToolCapabilityBinding = {
		capabilityName,
		kind: (snapshot.connectorKind ?? ref.kind).trim().toLowerCase(),
		instanceId: ref.instanceId,
		mcpToolName: tool.name,
	}

	const capability = defineCapability({
		name: capabilityName,
		domain: domainId,
		description:
			tool.description?.trim() ||
			tool.title?.trim() ||
			`Remote connector action (${ref.kind}) for ${tool.name}.`,
		keywords: buildKeywords(snapshot, tool, ref, domainKeywordRoots),
		readOnly: Boolean(
			(tool.annotations as Record<string, unknown> | undefined)?.[
				'readOnlyHint'
			],
		),
		idempotent: Boolean(
			(tool.annotations as Record<string, unknown> | undefined)?.[
				'idempotentHint'
			],
		),
		destructive: Boolean(
			(tool.annotations as Record<string, unknown> | undefined)?.[
				'destructiveHint'
			],
		),
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		async handler(args, ctx) {
			const client = createRemoteConnectorMcpClient(
				ctx.env,
				binding.kind,
				binding.instanceId,
			)
			let result: Awaited<ReturnType<typeof client.callTool>>
			try {
				result = await client.callTool(tool.name, args)
			} catch (error) {
				const status = await getRemoteConnectorStatus(ctx.env, {
					kind: binding.kind,
					instanceId: binding.instanceId,
				})
				if (status.state !== 'connected' || status.toolCount === 0) {
					throw new Error(formatRemoteConnectorUnavailableMessage(status))
				}
				const message =
					error instanceof Error ? error.message : 'Unknown connector error.'
				throw new Error(
					`Remote capability "${binding.kind}:${binding.instanceId}:${tool.name}" failed: ${message}`,
				)
			}
			if (
				result.structuredContent &&
				typeof result.structuredContent === 'object'
			) {
				return result.structuredContent as Record<string, unknown>
			}
			return {
				content: result.content,
				isError: result.isError ?? false,
			}
		},
	})

	return { capability, binding }
}

export async function synthesizeRemoteToolDomain(
	env: Env,
	ref: RemoteConnectorRef,
	allRefs: ReadonlyArray<RemoteConnectorRef>,
): Promise<SynthesizedRemoteConnectorDomain | null> {
	if (!isRemoteConnectorTrusted(ref)) return null

	const client = createRemoteConnectorMcpClient(env, ref.kind, ref.instanceId)
	const snapshot = await client.getSnapshot()
	if (!snapshot || snapshot.tools.length === 0) return null

	const domainId = remoteConnectorDomainId(ref)
	const capabilityPrefix = remoteConnectorCapabilityPrefix(ref, allRefs)
	const k = ref.kind.trim().toLowerCase()
	const isOnlyBuiltinHomeDomain =
		k === 'home' &&
		allRefs.length === 1 &&
		allRefs[0]?.kind === 'home' &&
		allRefs[0]?.instanceId.trim() === 'default'

	const domainIdForCapabilities: CapabilityDomain = isOnlyBuiltinHomeDomain
		? 'home'
		: domainId

	const domainKeywordRoots =
		k === 'home'
			? ([
					'home',
					'roku',
					'lutron',
					'venstar',
					'automation',
					'devices',
				] as const)
			: [k, 'integration', 'connector']

	const domainDescription =
		k === 'home'
			? 'Home automation capabilities discovered from the connected home connector.'
			: `Capabilities discovered from the connected "${ref.kind}" remote connector ("${ref.instanceId}").`

	const capabilities: Array<Capability> = []
	const bindings: Record<string, RemoteToolCapabilityBinding> = {}

	for (const tool of snapshot.tools) {
		const { capability, binding } = createCapabilityFromTool({
			snapshot,
			tool,
			ref,
			domainId: domainIdForCapabilities,
			capabilityPrefix,
			domainKeywordRoots,
		})
		capabilities.push(capability)
		bindings[binding.capabilityName] = binding
	}

	return {
		domain: defineDomain({
			name: domainIdForCapabilities,
			description: domainDescription,
			keywords: [...domainKeywordRoots],
			capabilities,
		}),
		bindings,
	}
}
