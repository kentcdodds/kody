import { expect, test } from 'vitest'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import { preferLocalCliExecuteGuidance } from '#mcp/instructions/prefer-local-cli-execute-guidance.ts'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { baseMcpServerInstructions } from '#mcp/server-instructions.ts'
import { apiToolDescription } from '#mcp/tools/api.ts'
import { searchTool } from '#mcp/tools/search-tool-definition.ts'

test('search and execute tool descriptions fit a 2048-character client cut', () => {
	expect(searchTool.description.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(executeToolDescription.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('prefer-local one-liner matches on server instructions, execute, and api', () => {
	expect(preferLocalCliExecuteGuidance.length).toBeGreaterThan(0)
	expect(baseMcpServerInstructions).toContain(preferLocalCliExecuteGuidance)
	expect(executeToolDescription).toContain(preferLocalCliExecuteGuidance)
	expect(apiToolDescription).toContain(preferLocalCliExecuteGuidance)
})
