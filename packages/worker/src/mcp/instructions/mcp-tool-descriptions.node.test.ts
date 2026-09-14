import { expect, test } from 'vitest'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { executeTool } from '#mcp/tools/execute-tool-definition.ts'
import { searchTool } from '#mcp/tools/search-tool-definition.ts'

/**
 * Advertised MCP tools. Keep this list in lockstep with `register-tools.ts`
 * so Claude Connectors Directory metadata cannot drift off a new tool.
 */
const advertisedMcpTools = [searchTool, executeTool] as const

test('search and execute tool descriptions fit a 2048-character client cut', () => {
	for (const tool of advertisedMcpTools) {
		expect(tool.description.length).toBeLessThan(
			mcpServerInstructionsClientHeadLimitChars,
		)
	}
})

test('advertised MCP tools meet Claude Connectors Directory metadata', () => {
	expect(advertisedMcpTools.map((tool) => tool.name)).toEqual([
		'search',
		'execute',
	])
	for (const tool of advertisedMcpTools) {
		expect(tool.name.length).toBeLessThanOrEqual(64)
		expect(tool.title.length).toBeGreaterThan(0)
		expect(tool.description.length).toBeGreaterThan(0)
		const readOnly = tool.annotations.readOnlyHint === true
		const destructive = tool.annotations.destructiveHint === true
		expect(
			readOnly || destructive,
			`${tool.name} needs readOnlyHint or destructiveHint`,
		).toBe(true)
	}
	expect(searchTool.annotations.readOnlyHint).toBe(true)
	expect(searchTool.annotations.destructiveHint).toBe(false)
	expect(executeTool.annotations.readOnlyHint).toBe(false)
	expect(executeTool.annotations.destructiveHint).toBe(true)
})
