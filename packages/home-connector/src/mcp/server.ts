import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createRokuAdapter } from '../adapters/roku/index.ts'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorState } from '../state.ts'

export type HomeConnectorToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type HomeConnectorToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

export type HomeConnectorToolRegistry = {
	list(): Array<HomeConnectorToolDescriptor>
	call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
}

export type HomeConnectorMcpServer = {
	server: McpServer
	listTools(): Array<HomeConnectorToolDescriptor>
	callTool(
		name: string,
		args?: Record<string, unknown>,
	): Promise<CallToolResult>
	createToolRegistry(): HomeConnectorToolRegistry
}

export function createHomeConnectorMcpServer(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
}): HomeConnectorMcpServer {
	const roku = createRokuAdapter({
		config: input.config,
		state: input.state,
	})

	const server = new McpServer(
		{
			name: 'kody-home-connector',
			version: '1.0.0',
		},
		{
			instructions:
				'Home connector MCP server. Tools currently focus on Roku discovery and control.',
		},
	)

	const tools = new Map<
		string,
		{
			descriptor: HomeConnectorToolDescriptor
			handler: HomeConnectorToolHandler
		}
	>()

	function registerTool(
		descriptor: HomeConnectorToolDescriptor,
		handler: HomeConnectorToolHandler,
	) {
		tools.set(descriptor.name, { descriptor, handler })
		server.registerTool(
			descriptor.name,
			{
				title: descriptor.title,
				description: descriptor.description,
				inputSchema: descriptor.inputSchema,
				...(descriptor.outputSchema
					? { outputSchema: descriptor.outputSchema }
					: {}),
				...(descriptor.annotations
					? { annotations: descriptor.annotations }
					: {}),
			},
			handler,
		)
	}

	registerTool(
		{
			name: 'roku_list_devices',
			title: 'List Roku Devices',
			description:
				'List discovered Roku devices and whether each device has been adopted for control.',
			inputSchema: {},
		},
		async () => {
			const devices = roku.getStatus().allDevices
			return {
				content: [
					{
						type: 'text',
						text:
							devices.length === 0
								? 'No Roku devices are currently known.'
								: devices
										.map(
											(device) =>
												`- ${device.name} (${device.deviceId}) adopted=${String(device.adopted)}`,
										)
										.join('\n'),
					},
				],
				structuredContent: {
					devices,
				},
			}
		},
	)

	registerTool(
		{
			name: 'roku_scan_devices',
			title: 'Scan Roku Devices',
			description:
				'Scan the local network for Roku devices using the configured Roku discovery endpoint.',
			inputSchema: {},
		},
		async () => {
			const devices = await roku.scan()
			return {
				content: [
					{
						type: 'text',
						text:
							devices.length === 0
								? 'No Roku devices discovered.'
								: `Discovered ${devices.length} Roku device(s).`,
					},
				],
				structuredContent: {
					devices,
				},
			}
		},
	)

	registerTool(
		{
			name: 'roku_adopt_device',
			title: 'Adopt Roku Device',
			description:
				'Mark a discovered Roku device as adopted so it becomes a managed device.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const device = roku.adoptDevice(String(args['deviceId'] ?? ''))
			return {
				content: [
					{
						type: 'text',
						text: `Adopted Roku device ${device.name}.`,
					},
				],
				structuredContent: device,
			}
		},
	)

	registerTool(
		{
			name: 'roku_ignore_device',
			title: 'Ignore Roku Device',
			description:
				'Mark a discovered Roku device as ignored so it remains visible but unmanaged.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const device = roku.ignoreDevice(String(args['deviceId'] ?? ''))
			return {
				content: [
					{
						type: 'text',
						text: `Ignored Roku device ${device.name}.`,
					},
				],
				structuredContent: device,
			}
		},
	)

	registerTool(
		{
			name: 'roku_press_key',
			title: 'Press Roku Key',
			description: 'Send a Roku ECP keypress to an adopted Roku device.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
					key: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const key = String(args['key'] ?? '')
			const result = await roku.pressKey(deviceId, key)
			return {
				content: [
					{
						type: 'text',
						text: `Sent ${key} to ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'roku_launch_app',
			title: 'Launch Roku App',
			description:
				'Launch a Roku app on an adopted device, optionally with deep-link parameters.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
					appId: z.string().min(1),
					params: z.record(z.string(), z.string()).optional(),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const appId = String(args['appId'] ?? '')
			const rawParams = args['params']
			const params =
				rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
					? Object.fromEntries(
							Object.entries(rawParams as Record<string, unknown>).map(
								([key, value]) => [key, String(value)],
							),
						)
					: undefined
			const result = await roku.launchApp(deviceId, appId, params)
			return {
				content: [
					{
						type: 'text',
						text: `Launched app ${appId} on ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	return {
		server,
		listTools() {
			return [...tools.values()].map((entry) => entry.descriptor)
		},
		async callTool(name, args = {}) {
			const tool = tools.get(name)
			if (!tool) {
				throw new Error(`Unknown connector tool "${name}".`)
			}
			return tool.handler(args)
		},
		createToolRegistry() {
			return {
				list() {
					return [...tools.values()].map((entry) => entry.descriptor)
				},
				call(name, args = {}) {
					const tool = tools.get(name)
					if (!tool) {
						throw new Error(`Unknown connector tool "${name}".`)
					}
					return tool.handler(args)
				},
			}
		},
	}
}
