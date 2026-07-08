import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { slugWithStableDisambiguator } from '@kody-internal/shared/stable-slug.ts'

export function mcpServerKodyName(ref: Pick<McpServerRef, 'name'>): string {
	return slugWithStableDisambiguator({
		value: ref.name,
		fallback: 'server',
		allowedPattern: /^[\w-]+$/,
		replacementPattern: /[^\w-]+/g,
	})
}

export function mcpServerDomainId(ref: Pick<McpServerRef, 'name'>): string {
	return `mcp:${mcpServerKodyName(ref)}`
}

export function mcpServerToolName(toolName: string): string {
	return slugWithStableDisambiguator({
		value: toolName,
		fallback: 'tool',
		allowedPattern: /^\w+$/,
		replacementPattern: /[^\w]+/g,
	})
}

export function mcpServerCapabilityId(input: {
	ref: Pick<McpServerRef, 'name'>
	toolName: string
}): string {
	return `mcp:${mcpServerKodyName(input.ref)}:${mcpServerToolName(input.toolName)}`
}
