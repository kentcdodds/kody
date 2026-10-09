import {
	buildMcpServerInstructions,
	describeAssembledMcpServerInstructions,
} from '#mcp/server-instructions.ts'

/**
 * Size the overlay against the same assembly the next MCP session would
 * serve. The 2048-character client-head warning stays even though the base
 * stub is short.
 */
export function describeUserMcpServerInstructionOverlay(input: {
	overlay: string | null
}): { assembled_chars: number; warning: string | null } {
	const assembled = buildMcpServerInstructions(input.overlay)
	return describeAssembledMcpServerInstructions({
		assembled,
		hasOverlay: Boolean(input.overlay?.trim()),
	})
}
