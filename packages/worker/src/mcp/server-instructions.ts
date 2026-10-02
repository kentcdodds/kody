import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'

/**
 * Neutral always-on MCP server instructions. Kept short so clients that
 * truncate the head (often ~2048 characters) still see how to use search /
 * execute. No prefer-over-host wording — package lifecycle and host-vs-Kody
 * guidance belong in skills / guides, not this stub.
 *
 * Copy is Kent-locked; change only with an explicit server-instructions update.
 */
export const baseMcpServerInstructions = `Kody is the user's personal software platform of primitives including:

- memory
- secrets
- packages (repositories of published code which you as the agent can use and compose together)
- integrations
- triggers
- apps

With these primitives you can do a wide variety of things. When the user asks you to do something, start by calling the \`search\` tool, then use \`execute\` to write code and have it evaluated in an isolated environment in the cloud in Kody.

If you have access to a computer with Node v22+, you can use Kody more efficiently and cheaply using the CLI. This is the preferred interaction layer. Learn more with \`search({ entity: "guide:local_execute" })\`.`

/** Soft budget for the always-on stub (excluding user overlay). */
export const maxBaseMcpServerInstructionsChars = 800

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
