import { expect, test } from 'vitest'
import { executeTool } from './execute.ts'
import { searchTool } from './search-tool-definition.ts'

/**
 * OpenAI Apps / ChatGPT plugin submission pins the public MCP surface to
 * exactly `search` + `execute` with these annotations. Drift here fails the
 * portal scan or misrepresents tool reachability.
 */
test('public MCP tools advertise the OpenAI submission annotation contract', () => {
	expect(searchTool.name).toBe('search')
	expect(searchTool.annotations).toEqual({
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	})

	expect(executeTool.name).toBe('execute')
	expect(executeTool.annotations).toEqual({
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	})
})
