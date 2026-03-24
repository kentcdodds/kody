import { type MCP } from './index.ts'
import { registerGeneratedUiAppResource } from './resources/generated-ui-app-resource.ts'

export async function registerResources(agent: MCP) {
	await registerGeneratedUiAppResource(agent)
}
