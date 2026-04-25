import * as Sentry from '@sentry/cloudflare'
import { invariant } from '@epic-web/invariant'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { createHomeMcpClient } from '#worker/home/client.ts'
import {
	formatHomeConnectorUnavailableMessage,
	getHomeConnectorStatus,
} from '#worker/home/status.ts'
import { type HomeToolDescriptor } from '#worker/home/types.ts'
import {
	parseMcpCallerContext,
	type McpServerProps,
} from '#worker/mcp/context.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

export type HomeMcpState = {}
export type HomeMcpProps = McpServerProps

const serverMetadata = {
	implementation: {
		name: 'kody-home-mcp',
		version: '1.0.0',
	},
	instructions: `
Internal home connector MCP bridge.

- This MCP server is for Kody's internal agent use only.
- The underlying home connector stays on the local network and connects outbound.
- Use 'home_list_tools' to inspect the connected home connector tools.
- Use 'home_call_tool' to invoke a specific raw home connector tool directly.
	`.trim(),
} as const

type HomeMcpBridge = {
	getCallerContext(): McpServerProps
	getEnv(): Env
	requireDomain(): string
	getHomeClient(): Promise<ReturnType<typeof createHomeMcpClient>>
}

function resolveHomeBridgeInstanceId(
	callerContext: McpServerProps,
): string | null {
	const refs = normalizeRemoteConnectorRefs(callerContext)
	const home = refs.find((r) => r.kind === 'home')
	return home?.instanceId ?? null
}

async function createHomeToolErrorResult(
	agent: HomeMcpBridge,
	error: unknown,
): Promise<CallToolResult> {
	const callerContext = agent.getCallerContext()
	const homeInstanceId = resolveHomeBridgeInstanceId(callerContext)
	const status = await getHomeConnectorStatus(agent.getEnv(), homeInstanceId)
	const fallbackMessage =
		error instanceof Error ? error.message : 'Unknown home connector error.'
	const message =
		status.state === 'connected'
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

function createHomeToolSummaryText(tools: Array<HomeToolDescriptor>) {
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

async function registerBridgeTools(agent: HomeMcpBridge) {
	const server = (agent as unknown as { server: McpServer }).server

	server.registerTool(
		'home_list_tools',
		{
			title: 'List Home Connector Tools',
			description: 'List raw tools exposed by the connected home connector.',
			inputSchema: {},
		},
		async () => {
			try {
				const client = await agent.getHomeClient()
				const tools = await client.listTools()
				return {
					content: [
						{
							type: 'text',
							text: createHomeToolSummaryText(tools),
						},
					],
					structuredContent: {
						tools,
					},
				}
			} catch (error) {
				return createHomeToolErrorResult(agent, error)
			}
		},
	)

	server.registerTool(
		'home_call_tool',
		{
			title: 'Call Home Connector Tool',
			description:
				'Call a raw home connector tool by name with a JSON arguments object.',
			inputSchema: {
				name: z
					.string()
					.min(1)
					.describe(
						'Exact home connector tool name, such as `roku_list_devices`.',
					),
				arguments: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Optional JSON arguments for the tool call.'),
			},
		},
		async (args: { name: string; arguments?: Record<string, unknown> }) => {
			try {
				const client = await agent.getHomeClient()
				return await client.callTool(args.name, args.arguments)
			} catch (error) {
				return createHomeToolErrorResult(agent, error)
			}
		},
	)
}

class HomeMCPBase extends McpAgent<Env, HomeMcpState, HomeMcpProps> {
	server = new McpServer(serverMetadata.implementation, {
		instructions: serverMetadata.instructions,
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	})

	async init() {
		await registerBridgeTools(this)
	}

	getCallerContext() {
		return parseMcpCallerContext(this.props)
	}

	getEnv() {
		return this.env
	}

	requireDomain() {
		const { baseUrl } = this.getCallerContext()
		invariant(
			baseUrl,
			'This should never happen, but somehow we did not get the baseUrl from the request handler',
		)
		return baseUrl
	}

	async getHomeClient() {
		const homeInstanceId = resolveHomeBridgeInstanceId(this.getCallerContext())
		if (!homeInstanceId) {
			throw new Error(
				'No home connector is associated with this MCP caller context.',
			)
		}

		return createHomeMcpClient(this.env, homeInstanceId)
	}
}

export const HomeMCP = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	HomeMCPBase,
)

export type HomeMCP = InstanceType<typeof HomeMCP>
