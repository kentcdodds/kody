import { type MCP } from './index.ts'
import { registerCalculatorAppResource } from './resources/calculator-app-resource.ts'

export async function registerResources(agent: MCP) {
	await registerCalculatorAppResource(agent)
}
