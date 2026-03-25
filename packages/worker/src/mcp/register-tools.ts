import type { MCP } from './index.ts'
import { registerExecuteTool } from './tools/execute.ts'
import { registerOpenGeneratedUiTool } from './tools/open-generated-ui.ts'
import { registerSearchTool } from './tools/search.ts'

export async function registerTools(agent: MCP) {
	await registerSearchTool(agent)
	await registerExecuteTool(agent)
	await registerOpenGeneratedUiTool(agent)
}
