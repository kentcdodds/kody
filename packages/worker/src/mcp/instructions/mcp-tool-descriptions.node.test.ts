import { expect, test } from 'vitest'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { baseMcpServerInstructions } from '#mcp/server-instructions.ts'
import { apiToolDescription } from '#mcp/tools/api.ts'
import { executeTool } from '#mcp/tools/execute.ts'
import { searchTool } from '#mcp/tools/search-tool-definition.ts'

test('search and execute tool descriptions fit a 2048-character client cut', () => {
	expect(searchTool.description.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(executeToolDescription.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('search and execute titles stay action + subject; guidance lives in descriptions', () => {
	expect(searchTool.title).toBe('Search catalog')
	expect(executeTool.title).toBe('Execute code')
	expect(searchTool.description).toContain('built-in capabilities')
	expect(searchTool.description).toContain('secret references')
	expect(executeTool.description).toContain('ephemeral ESM module')
	expect(executeTool.description).toContain(
		'Discover the capability with search',
	)
})

test('prefer-local one-liner matches on server instructions, execute, and api', () => {
	const line =
		'When Node ≥22 and the Kody CLI are available, run code with `kody execute --local`.'
	expect(baseMcpServerInstructions).toContain(line)
	expect(executeToolDescription).toContain(line)
	expect(apiToolDescription).toContain(line)
})
