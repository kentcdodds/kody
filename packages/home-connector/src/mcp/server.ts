import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createRokuAdapter } from '../adapters/roku/index.ts'
import { type createSamsungTvAdapter } from '../adapters/samsung-tv/index.ts'
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
	samsungTv: ReturnType<typeof createSamsungTvAdapter>
}): HomeConnectorMcpServer {
	const roku = createRokuAdapter({
		config: input.config,
		state: input.state,
	})
	const samsungTv = input.samsungTv

	const server = new McpServer(
		{
			name: 'kody-home-connector',
			version: '1.0.0',
		},
		{
			instructions:
				'Home connector MCP server. Tools currently support Roku and Samsung TV discovery, control, and diagnostics.',
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

	registerTool(
		{
			name: 'roku_list_apps',
			title: 'List Roku Apps',
			description:
				'List installed Roku apps on an adopted device using the Roku ECP app query.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			outputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string(),
					deviceName: z.string(),
					apps: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							type: z.string(),
							version: z.string(),
						}),
					),
					responseText: z.string(),
				}),
			) as Record<string, unknown>,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await roku.listApps(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Fetched ${result.apps.length} app(s) from ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'roku_get_active_app',
			title: 'Get Active Roku App',
			description: 'Get the currently active Roku app on an adopted device.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			outputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string(),
					deviceName: z.string(),
					app: z
						.object({
							id: z.string(),
							name: z.string(),
							type: z.string(),
							version: z.string(),
						})
						.nullable(),
					responseText: z.string(),
				}),
			) as Record<string, unknown>,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await roku.getActiveApp(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: result.app
							? `Active app on ${deviceId} is ${result.app.name}.`
							: `No active Roku app reported for ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_list_devices',
			title: 'List Samsung TVs',
			description:
				'List discovered Samsung TVs, whether they are adopted, and whether a pairing token is stored.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const devices = samsungTv.getStatus().allDevices
			return {
				content: [
					{
						type: 'text',
						text:
							devices.length === 0
								? 'No Samsung TVs are currently known.'
								: devices
										.map(
											(device) =>
												`- ${device.name} (${device.deviceId}) adopted=${String(device.adopted)} paired=${String(Boolean(device.token))}`,
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
			name: 'samsung_scan_devices',
			title: 'Scan Samsung TVs',
			description:
				'Scan the local network for Samsung TVs using the configured discovery mechanism.',
			inputSchema: {},
		},
		async () => {
			const devices = await samsungTv.scan()
			return {
				content: [
					{
						type: 'text',
						text:
							devices.length === 0
								? 'No Samsung TVs discovered.'
								: `Discovered ${devices.length} Samsung TV device(s).`,
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
			name: 'samsung_adopt_device',
			title: 'Adopt Samsung TV',
			description:
				'Mark a discovered Samsung TV as adopted so it becomes a managed device.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const device = samsungTv.adoptDevice(String(args['deviceId'] ?? ''))
			return {
				content: [
					{
						type: 'text',
						text: `Adopted Samsung TV ${device.name}.`,
					},
				],
				structuredContent: device,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_get_device_info',
			title: 'Get Samsung TV Device Info',
			description:
				'Read current device metadata from a Samsung TV over its local api/v2 endpoint.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.getDeviceInfo(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Fetched Samsung TV device info for ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_pair_device',
			title: 'Pair Samsung TV',
			description:
				'Establish a tokened remote session with a Samsung TV and persist the token locally.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.pairDevice(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Paired Samsung TV ${result.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_press_key',
			title: 'Press Samsung TV Key',
			description: 'Send a remote key to an adopted, paired Samsung TV.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
					key: z.string().min(1),
					times: z.number().int().min(1).max(20).optional(),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const key = String(args['key'] ?? '')
			const rawTimes = args['times']
			const times =
				typeof rawTimes === 'number' && Number.isFinite(rawTimes) ? rawTimes : 1
			const result = await samsungTv.pressKey(deviceId, key, times)
			return {
				content: [
					{
						type: 'text',
						text: `Sent ${key} to Samsung TV ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_go_home',
			title: 'Go Home On Samsung TV',
			description: 'Send the Home key to an adopted, paired Samsung TV.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.goHome(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Sent Home to Samsung TV ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_power_off',
			title: 'Power Off Samsung TV',
			description:
				'Best-effort power off for an adopted, paired Samsung TV using the local remote channel.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.powerOff(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Sent power off to Samsung TV ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_power_on',
			title: 'Power On Samsung TV',
			description:
				'Best-effort power on for an adopted Samsung TV using Wake-on-LAN and the stored TV MAC address.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.powerOn(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Sent Wake-on-LAN power on to Samsung TV ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_get_known_apps_status',
			title: 'Get Known Samsung TV Apps Status',
			description:
				'Check a curated set of common app IDs to see which apps are installed on a Samsung TV.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.getKnownAppsStatus(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Checked known Samsung TV apps for ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_launch_app',
			title: 'Launch Samsung TV App',
			description:
				'Launch a Samsung TV app by explicit app ID on an adopted device.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
					appId: z.string().min(1),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const appId = String(args['appId'] ?? '')
			const result = await samsungTv.launchApp(deviceId, appId)
			return {
				content: [
					{
						type: 'text',
						text: `Launched Samsung TV app ${appId} on ${deviceId}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_get_art_mode',
			title: 'Get Samsung TV Art Mode',
			description:
				'Get the current Art Mode state for an adopted, paired Samsung Frame TV.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
				}),
			) as Record<string, unknown>,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const result = await samsungTv.getArtMode(deviceId)
			return {
				content: [
					{
						type: 'text',
						text: `Samsung TV ${deviceId} art mode is ${result.mode}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_set_art_mode',
			title: 'Set Samsung TV Art Mode',
			description: 'Turn Samsung Frame TV Art Mode on or off.',
			inputSchema: z.toJSONSchema(
				z.object({
					deviceId: z.string().min(1),
					mode: z.enum(['on', 'off']),
				}),
			) as Record<string, unknown>,
		},
		async (args) => {
			const deviceId = String(args['deviceId'] ?? '')
			const mode = args['mode'] === 'on' ? 'on' : 'off'
			const result = await samsungTv.setArtMode(deviceId, mode)
			return {
				content: [
					{
						type: 'text',
						text: `Turned Samsung TV ${deviceId} art mode ${mode}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'samsung_get_status',
			title: 'Get Samsung TV Summary Status',
			description:
				'Get a connector-level summary of paired Samsung TVs, diagnostics, and current Art Mode state when available.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const result = await samsungTv.getSummary()
			return {
				content: [
					{
						type: 'text',
						text: `Samsung TV summary includes ${result.deviceCount} device(s) with ${result.pairedCount} paired.`,
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
