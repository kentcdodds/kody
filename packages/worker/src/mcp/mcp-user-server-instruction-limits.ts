/** Max characters for user-provided MCP server instructions (stored per user). */
export const maxUserMcpServerInstructionsChars = 4_000

/**
 * Some MCP clients keep only the first N characters of server instructions
 * (Claude Code documents a 2KB cut). Overlay get/set warn when assembled
 * instructions meet this limit.
 */
export const mcpServerInstructionsClientHeadLimitChars = 2_048
