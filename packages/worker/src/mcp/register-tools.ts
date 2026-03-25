import { type McpRegistrationAgent } from './mcp-registration-agent.ts'
import { registerExecuteTool } from './tools/execute.ts'
import { registerOpenGeneratedUiTool } from './tools/open-generated-ui.ts'
import { registerSearchTool } from './tools/search.ts'

export async function registerTools(agent: McpRegistrationAgent) {
	await registerSearchTool(agent)
	await registerExecuteTool(agent)
	await registerOpenGeneratedUiTool(agent)
}
