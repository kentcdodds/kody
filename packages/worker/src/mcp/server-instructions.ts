import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'

/**
 * Neutral always-on MCP server instructions. Kept short so clients that
 * truncate the head (often ~2048 characters) still see how to use search /
 * execute. No prefer-over-host wording — package lifecycle and host-vs-Kody
 * guidance belong in skills / guides, not this stub.
 */
export const baseMcpServerInstructions = `Kody is each signed-in user's isolated personal assistant (packages, jobs, secrets, memories, connectors, email, storage), exposed as MCP \`search\` and \`execute\`.

Start with \`search({ query })\`; open entity detail, then call. For one-off work when Node ≥22 and the CLI are available, see \`search({ entity: "guide:open_api" })\` for \`@kodycodes/cli execute --local\`; otherwise use Open API or MCP \`api\`. Docs: https://kody.codes/docs.

Keep secrets server-side. Verify memory writes with \`metaMemoryVerify\` before upsert/delete.`

/** Soft budget for the always-on stub (excluding user overlay). */
export const maxBaseMcpServerInstructionsChars = 600

const userMcpServerInstructionOverlayHeader = `---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):`

export function appendUserMcpServerInstructionOverlay(
	base: string,
	userOverlay: string | null | undefined,
): string {
	const trimmed = userOverlay?.trim()
	if (!trimmed) return base
	return `${base}

${userMcpServerInstructionOverlayHeader}
${trimmed}`
}

export function buildMcpServerInstructions(
	userOverlay?: string | null | undefined,
): string {
	return appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		userOverlay,
	)
}

export function describeAssembledMcpServerInstructions(input: {
	assembled: string
	hasOverlay: boolean
}): { assembled_chars: number; warning: string | null } {
	const assembled_chars = input.assembled.length
	if (
		!input.hasOverlay ||
		assembled_chars < mcpServerInstructionsClientHeadLimitChars
	) {
		return { assembled_chars, warning: null }
	}
	return {
		assembled_chars,
		warning: `Assembled MCP server instructions are ${String(assembled_chars)} characters. Some clients keep only the first ${String(mcpServerInstructionsClientHeadLimitChars)} characters, so this overlay may never reach the model. Prefer memories for durable facts; keep the overlay short.`,
	}
}
