import { type McpRegistrationAgent } from './mcp-registration-agent.ts'
import { registerGeneratedUiAppResource } from './resources/generated-ui-app-resource.ts'

export async function registerResources(agent: McpRegistrationAgent) {
	await registerGeneratedUiAppResource(agent)
}
