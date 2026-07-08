import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'

function fnv1a32(input: string) {
	let hash = 2_166_136_261
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 16_777_619)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

function slugWithStableDisambiguator(input: {
	value: string
	fallback: string
	allowedPattern: RegExp
	replacementPattern: RegExp
}) {
	const trimmed = input.value.trim()
	const slug =
		trimmed
			.replaceAll(input.replacementPattern, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || input.fallback
	if (trimmed && input.allowedPattern.test(trimmed) && slug === trimmed) {
		return slug
	}
	return `${slug}_${fnv1a32(trimmed)}`
}

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
