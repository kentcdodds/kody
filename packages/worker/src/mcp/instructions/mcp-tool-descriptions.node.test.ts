import { expect, test } from 'vitest'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import { quickStartInstructions } from '#mcp/instructions/base-server-fragments.ts'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { searchTool } from '#mcp/tools/search-tool-definition.ts'

test('search and execute tool descriptions fit a 2048-character client cut', () => {
	expect(searchTool.description.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(executeToolDescription.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('execute tool description teaches params reuse with a concrete example', () => {
	expect(executeToolDescription).toMatch(/vary args via `params`/)
	expect(executeToolDescription).toContain('main(params)')
	expect(executeToolDescription).toContain('kody.capability_id(params)')
	expect(executeToolDescription).not.toMatch(/`invoke`|execute-invoke/)
})

test('quickStart MCP instructions teach params reuse early for the 2048 cut', () => {
	expect(quickStartInstructions).toContain('main(params)')
	expect(quickStartInstructions).toContain('kody.emailSend(params)')
	expect(quickStartInstructions).toMatch(/not literals in `code`/)
	expect(quickStartInstructions).not.toMatch(/`invoke`|execute-invoke/)
})
