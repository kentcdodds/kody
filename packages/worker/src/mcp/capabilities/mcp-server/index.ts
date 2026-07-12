import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { type CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import {
	mcpServerCapabilityId,
	mcpServerDomainId,
	mcpServerKodyName,
	mcpServerToolName,
} from '#worker/mcp-client/mcp-domain-id.ts'
import {
	formatMcpServerUnavailableMessage,
	getMcpServerStatus,
} from '#worker/mcp-client/status.ts'
import {
	type McpServerSnapshot,
	type McpServerToolDescriptor,
} from '#worker/mcp-client/types.ts'
import { wrapDownstreamMcpToolResult } from '#mcp/downstream-mcp-result.ts'

type McpServerToolCapabilityBinding = {
	capabilityName: string
	serverId: string
	mcpToolName: string
}

export type SynthesizedMcpServerDomain = {
	domain: DomainSpec
	bindings: Record<string, McpServerToolCapabilityBinding>
}

function buildKeywords(
	tool: McpServerToolDescriptor,
	ref: McpServerRef,
	extraRoots: ReadonlyArray<string>,
) {
	const words = [
		...extraRoots,
		'mcp',
		'server',
		tool.name,
		tool.title ?? '',
		tool.description ?? '',
		ref.name,
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
	tool: McpServerToolDescriptor
	ref: McpServerRef
	domainId: CapabilityDomain
	domainKeywordRoots: ReadonlyArray<string>
}): { capability: Capability; binding: McpServerToolCapabilityBinding } {
	const { tool, ref, domainId, domainKeywordRoots } = input
	const capabilityName = mcpServerCapabilityId({
		ref,
		toolName: tool.name,
	})
	const kodyName = mcpServerKodyName(ref)
	const cleanToolName = mcpServerToolName(tool.name)
	const binding: McpServerToolCapabilityBinding = {
		capabilityName,
		serverId: ref.serverId,
		mcpToolName: tool.name,
	}

	const capability = defineCapability({
		name: capabilityName,
		domain: domainId,
		description:
			tool.description?.trim() ||
			tool.title?.trim() ||
			`MCP server tool ${tool.name}.`,
		keywords: buildKeywords(tool, ref, domainKeywordRoots),
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
		source: 'mcp-server',
		mcpServer: {
			serverId: ref.serverId,
			serverName: ref.name,
			kodyName,
			mcpToolName: binding.mcpToolName,
			toolName: cleanToolName,
		},
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		async handler(args, ctx) {
			const userId = ctx.callerContext.user?.userId
			if (!userId) {
				throw new Error(
					`MCP server capability "${ref.name}:${tool.name}" requires an authenticated user.`,
				)
			}
			const hub = createMcpClientHubClient({
				env: ctx.env,
				userId,
			})
			let result: Awaited<ReturnType<typeof hub.callTool>>
			try {
				result = await hub.callTool({
					serverId: binding.serverId,
					toolName: tool.name,
					args: (args ?? {}) as Record<string, unknown>,
				})
			} catch (error) {
				// The status check adds context for disconnected servers, but it
				// must never mask the original tool-call error if it fails itself.
				const status = await getMcpServerStatus({
					env: ctx.env,
					userId,
					ref,
				}).catch(() => null)
				if (status && (!status.ready || status.toolCount === 0)) {
					throw new Error(formatMcpServerUnavailableMessage(status))
				}
				const message =
					error instanceof Error ? error.message : 'Unknown MCP server error.'
				throw new Error(
					`MCP server capability "${ref.name}:${tool.name}" failed: ${message}`,
				)
			}
			return wrapDownstreamMcpToolResult(result, {
				kind: 'mcp-server',
				label: `${ref.name}:${tool.name}`,
			})
		},
	})

	return { capability, binding }
}

export function synthesizeMcpServerToolDomain(input: {
	ref: McpServerRef
	snapshot: McpServerSnapshot | null
}): SynthesizedMcpServerDomain | null {
	const { ref, snapshot } = input
	if (!snapshot || snapshot.state !== 'ready' || snapshot.tools.length === 0) {
		return null
	}

	const domainId = mcpServerDomainId(ref)
	const domainIdForCapabilities: CapabilityDomain = domainId

	const domainKeywordRoots = [snapshot.instructions ?? '', 'integration', 'mcp']

	const domainDescription =
		snapshot.instructions?.trim() ||
		`Capabilities discovered from the connected MCP server "${ref.name}".`

	const capabilities: Array<Capability> = []
	const bindings: Record<string, McpServerToolCapabilityBinding> = {}

	for (const tool of snapshot.tools) {
		const { capability, binding } = createCapabilityFromTool({
			tool,
			ref,
			domainId: domainIdForCapabilities,
			domainKeywordRoots,
		})
		capabilities.push(capability)
		bindings[binding.capabilityName] = binding
	}

	return {
		domain: defineDomain({
			name: domainIdForCapabilities,
			description: domainDescription,
			keywords: ['mcp', 'integration'],
			capabilities,
		}),
		bindings,
	}
}
