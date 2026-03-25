import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createHomeMcpClient } from '#worker/home/client.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { type HomeConnectorSnapshot } from '#worker/home/types.ts'

type HomeCapabilityBinding = {
	capabilityName: string
	connectorId: string
	mcpToolName: string
}

export type SynthesizedHomeDomain = {
	domain: DomainSpec
	bindings: Record<string, HomeCapabilityBinding>
}

function createCapabilityName(toolName: string) {
	return `home_${toolName.replaceAll(/[^\w]+/g, '_').replaceAll(/_+/g, '_')}`
}

function buildKeywords(
	snapshot: HomeConnectorSnapshot,
	tool: HomeConnectorSnapshot['tools'][number],
) {
	const words = [
		'home',
		tool.name,
		tool.title ?? '',
		tool.description ?? '',
		snapshot.connectorId,
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

function createCapabilityFromTool(
	snapshot: HomeConnectorSnapshot,
	tool: HomeConnectorSnapshot['tools'][number],
): { capability: Capability; binding: HomeCapabilityBinding } {
	const capabilityName = createCapabilityName(tool.name)
	const binding: HomeCapabilityBinding = {
		capabilityName,
		connectorId: snapshot.connectorId,
		mcpToolName: tool.name,
	}

	const capability = defineCapability({
		name: capabilityName,
		domain: capabilityDomainNames.home,
		description:
			tool.description?.trim() ||
			tool.title?.trim() ||
			`Home automation action for ${tool.name}.`,
		keywords: buildKeywords(snapshot, tool),
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
			const client = createHomeMcpClient(ctx.env, snapshot.connectorId)
			const result = await client.callTool(tool.name, args)
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

export async function synthesizeHomeDomain(
	env: Env,
	input: {
		connectorId: string | null
		baseUrl: string
	},
): Promise<SynthesizedHomeDomain | null> {
	if (!input.connectorId) {
		return null
	}

	const client = createHomeMcpClient(env, input.connectorId)
	const snapshot = await client.getSnapshot()
	if (!snapshot || snapshot.tools.length === 0) return null

	const capabilities: Array<Capability> = []
	const bindings: Record<string, HomeCapabilityBinding> = {}

	for (const tool of snapshot.tools) {
		const { capability, binding } = createCapabilityFromTool(snapshot, tool)
		capabilities.push(capability)
		bindings[binding.capabilityName] = binding
	}

	return {
		domain: defineDomain({
			name: capabilityDomainNames.home,
			description:
				'Home automation capabilities discovered from the connected home connector.',
			keywords: ['home', 'roku', 'automation', 'devices'],
			capabilities,
		}),
		bindings,
	}
}
