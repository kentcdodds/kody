import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createHomeMcpClient } from '#worker/home/client.ts'
import {
	formatHomeConnectorUnavailableMessage,
	getHomeConnectorStatus,
} from '#worker/home/status.ts'
import { type HomeToolDescriptor } from '#worker/home/types.ts'
import { type McpServerProps } from '#worker/mcp/context.ts'
import {
	type NormalizedRemoteConnectorRef,
	normalizeRemoteConnectorRefs,
} from '@kody-internal/shared/remote-connectors.ts'

export type HomeMcpBridge = {
	getCallerContext(): McpServerProps
	getEnv(): Env
	requireDomain(): string
	getHomeClient(): Promise<ReturnType<typeof createHomeMcpClient>>
}

export function resolveHomeBridgeRef(
	callerContext: McpServerProps,
): NormalizedRemoteConnectorRef | null {
	const refs = normalizeRemoteConnectorRefs(callerContext)
	const home = refs.find((r) => r.kind === 'home')
	return home ?? null
}

export async function createHomeToolErrorResult(
	agent: HomeMcpBridge,
	error: unknown,
): Promise<CallToolResult> {
	const callerContext = agent.getCallerContext()
	const homeRef = resolveHomeBridgeRef(callerContext)
	const status = await getHomeConnectorStatus(agent.getEnv(), homeRef)
	const fallbackMessage =
		error instanceof Error ? error.message : 'Unknown home connector error.'
	const message =
		status.state === 'connected' && status.trusted
			? `Home connector request failed: ${fallbackMessage}`
			: formatHomeConnectorUnavailableMessage(status)

	return {
		content: [
			{
				type: 'text',
				text: message,
			},
		],
		structuredContent: {
			error: message,
			homeConnectorStatus: status,
		},
		isError: true,
	}
}

export function createHomeToolSummaryText(tools: Array<HomeToolDescriptor>) {
	if (tools.length === 0) {
		return 'No home connector tools are available.'
	}

	return tools
		.map((tool) => {
			const title = tool.title?.trim() || tool.name
			const description = tool.description?.trim() || 'No description.'
			return `- ${title} (\`${tool.name}\`): ${description}`
		})
		.join('\n')
}
