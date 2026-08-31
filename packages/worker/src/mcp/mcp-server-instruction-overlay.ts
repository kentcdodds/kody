import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import { compactMcpServerInstructionsFlagKey } from '#mcp/instructions/compact-mcp-server-instructions.ts'
import {
	buildMcpServerInstructions,
	describeAssembledMcpServerInstructions,
} from '#mcp/server-instructions.ts'

/**
 * Size the overlay against the same assembly the next MCP session would
 * serve. Compact vs full is the experiment branch; the 2048-character
 * warning stays after the flag is deleted.
 */
export async function describeUserMcpServerInstructionOverlay(input: {
	env: Env
	callerContext: McpCallerContext
	overlay: string | null
}): Promise<{ assembled_chars: number; warning: string | null }> {
	const flags = await resolveCallerFeatureFlags(input.env, input.callerContext)
	const assembled = buildMcpServerInstructions({
		userOverlay: input.overlay,
		compact: flags[compactMcpServerInstructionsFlagKey] === true,
		displayName: input.callerContext.user?.displayName,
	})
	return describeAssembledMcpServerInstructions({
		assembled,
		hasOverlay: Boolean(input.overlay?.trim()),
	})
}
