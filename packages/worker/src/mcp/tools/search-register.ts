import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'

import {
	searchTool,
	searchToolInputSchema,
	type SearchToolArgs,
} from './search-tool-definition.ts'
import { runSearchTool } from './search-tool-runner.ts'

export async function registerSearchTool(agent: McpRegistrationAgent) {
	agent.server.registerTool(
		searchTool.name,
		{
			title: searchTool.title,
			description: searchTool.description,
			inputSchema: searchToolInputSchema,
			annotations: searchTool.annotations,
		},
		async (args: SearchToolArgs) => runSearchTool({ agent, args }),
	)
}
