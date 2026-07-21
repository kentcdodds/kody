import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { type CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import { createRemoteConnectorMcpClient } from '#worker/remote-connector/client.ts'
import {
	formatRemoteConnectorUnavailableMessage,
	getRemoteConnectorStatus,
} from '#worker/remote-connector/status.ts'
import {
	remoteConnectorCapabilityId,
	remoteConnectorKodyName,
	remoteConnectorDomainId,
	remoteConnectorToolName,
} from '#worker/remote-connector/remote-domain-id.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { type RemoteConnectorSnapshot } from '#worker/remote-connector/types.ts'
import { wrapDownstreamMcpToolResult } from '#mcp/downstream-mcp-result.ts'

type RemoteToolCapabilityBinding = {
	capabilityName: string
	instanceId: string
	mcpToolName: string
}

export type SynthesizedRemoteConnectorDomain = {
	domain: DomainSpec
	bindings: Record<string, RemoteToolCapabilityBinding>
}

function buildKeywords(
	snapshot: RemoteConnectorSnapshot,
	tool: RemoteConnectorSnapshot['tools'][number],
	ref: RemoteConnectorRef,
) {
	const words = [
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
	snapshot: RemoteConnectorSnapshot
	tool: RemoteConnectorSnapshot['tools'][number]
	ref: RemoteConnectorRef
	domainId: CapabilityDomain
}): { capability: Capability; binding: RemoteToolCapabilityBinding } {
	const { snapshot, tool, ref, domainId } = input
	const capabilityName = remoteConnectorCapabilityId({
		ref,
		toolName: tool.name,
	})
	const connectorName = remoteConnectorKodyName(ref)
	const cleanToolName = remoteConnectorToolName(tool.name)
	const binding: RemoteToolCapabilityBinding = {
		capabilityName,
		instanceId: ref.instanceId,
		mcpToolName: tool.name,
	}

	const capability = defineCapability({
		name: capabilityName,
		domain: domainId,
		description:
			tool.description?.trim() ||
			tool.title?.trim() ||
			`Remote connector action for ${tool.name}.`,
		keywords: buildKeywords(snapshot, tool, ref),
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
		source: 'remote-connector',
		remoteConnector: {
			instanceId: binding.instanceId,
			connectorId: snapshot.connectorId,
			connectorName,
			mcpToolName: binding.mcpToolName,
			toolName: cleanToolName,
		},
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		async handler(args, ctx) {
			const userId = ctx.callerContext.user?.userId
			if (!userId) {
				throw new Error(
					`Remote capability "${binding.instanceId}:${tool.name}" requires an authenticated user.`,
				)
			}
			const client = createRemoteConnectorMcpClient({
				env: ctx.env,
				userId,
				instanceId: binding.instanceId,
			})
			let result: Awaited<ReturnType<typeof client.callTool>>
			try {
				result = await client.callTool(tool.name, args)
			} catch (error) {
				const status = await getRemoteConnectorStatus({
					env: ctx.env,
					userId,
					ref: {
						instanceId: binding.instanceId,
					},
				})
				if (status.state !== 'connected' || status.toolCount === 0) {
					throw new Error(formatRemoteConnectorUnavailableMessage(status))
				}
				const message =
					error instanceof Error ? error.message : 'Unknown connector error.'
				throw new Error(
					`Remote capability "${binding.instanceId}:${tool.name}" failed: ${message}`,
				)
			}
			return wrapDownstreamMcpToolResult(result, {
				kind: 'remote-connector',
				label: `${binding.instanceId}:${tool.name}`,
			})
		},
	})

	return { capability, binding }
}

export async function synthesizeRemoteToolDomain(input: {
	env: Env
	userId: string
	ref: RemoteConnectorRef
	snapshot?: RemoteConnectorSnapshot | null
}): Promise<SynthesizedRemoteConnectorDomain | null> {
	const snapshot =
		input.snapshot !== undefined
			? input.snapshot
			: await createRemoteConnectorMcpClient({
					env: input.env,
					userId: input.userId,
					instanceId: input.ref.instanceId,
				}).getSnapshot()
	const ref = input.ref
	if (!snapshot || snapshot.tools.length === 0) return null

	const domainId = remoteConnectorDomainId(ref)
	const domainIdForCapabilities: CapabilityDomain = domainId

	const domainKeywordRoots = [
		snapshot.description ?? '',
		'integration',
		'connector',
	]

	const domainDescription =
		snapshot.description?.trim() ||
		`Capabilities discovered from the connected remote connector "${ref.instanceId}".`

	const capabilities: Array<Capability> = []
	const bindings: Record<string, RemoteToolCapabilityBinding> = {}

	for (const tool of snapshot.tools) {
		const { capability, binding } = createCapabilityFromTool({
			snapshot,
			tool,
			ref,
			domainId: domainIdForCapabilities,
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
