import * as Sentry from '@sentry/node'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { type createAccessNetworksUnleashedAdapter } from '../adapters/access-networks-unleashed/index.ts'
import { type createBondAdapter } from '../adapters/bond/index.ts'
import { type createIslandRouterAdapter } from '../adapters/island-router/index.ts'
import { type createJellyfishAdapter } from '../adapters/jellyfish/index.ts'
import { isLutronProcessorNotFoundError } from '../adapters/lutron/errors.ts'
import { type createLutronAdapter } from '../adapters/lutron/index.ts'
import { createRokuAdapter } from '../adapters/roku/index.ts'
import { type createSonosAdapter } from '../adapters/sonos/index.ts'
import { type createSamsungTvAdapter } from '../adapters/samsung-tv/index.ts'
import { type createVenstarAdapter } from '../adapters/venstar/index.ts'
import { type HomeConnectorConfig } from '../config.ts'
import { registerAccessNetworksUnleashedHomeConnectorTools } from './register-access-networks-unleashed-tools.ts'
import { registerBondHomeConnectorTools } from './register-bond-tools.ts'
import { registerIslandRouterHomeConnectorTools } from './register-island-router-tools.ts'
import { type HomeConnectorState } from '../state.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

export type HomeConnectorToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type HomeConnectorRegisteredToolDescriptor = HomeConnectorToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
	sdkOutputSchema?: ToolInputSchema
}

type HomeConnectorToolHandler = (
	args: Record<string, unknown>,
	context?: HomeConnectorToolCallContext,
) => Promise<CallToolResult>

type HomeConnectorToolCallContext = {
	requestId?: string
	sessionId?: string
	transport?: string
	source?: string
}

export type HomeConnectorToolRegistry = {
	list(): Array<HomeConnectorToolDescriptor>
	call(
		name: string,
		args?: Record<string, unknown>,
		context?: HomeConnectorToolCallContext,
	): Promise<CallToolResult>
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
	lutron: ReturnType<typeof createLutronAdapter>
	sonos: ReturnType<typeof createSonosAdapter>
	bond: ReturnType<typeof createBondAdapter>
	jellyfish: ReturnType<typeof createJellyfishAdapter>
	venstar: ReturnType<typeof createVenstarAdapter>
	islandRouter: ReturnType<typeof createIslandRouterAdapter>
	accessNetworksUnleashed: ReturnType<
		typeof createAccessNetworksUnleashedAdapter
	>
}): HomeConnectorMcpServer {
	const roku = createRokuAdapter({
		config: input.config,
		state: input.state,
	})
	const samsungTv = input.samsungTv
	const lutron = input.lutron
	const sonos = input.sonos
	const bond = input.bond
	const jellyfish = input.jellyfish
	const venstar = input.venstar
	const islandRouter = input.islandRouter
	const accessNetworksUnleashed = input.accessNetworksUnleashed

	const server = new McpServer(
		{
			name: 'kody-home-connector',
			version: '1.0.0',
		},
		{
			instructions:
				"Home connector MCP server. Tools support Roku, Samsung TV, Lutron, Sonos, Bond (Olibra Bond Bridge / shades, groups, and RF devices), JellyFish Lighting, Venstar WiFi thermostat control, Island router status plus exact allowlisted Island CLI command strings, and a single generic Access Networks / RUCKUS Unleashed WiFi raw-request capability. Use 'access_networks_unleashed_scan_controllers', 'access_networks_unleashed_adopt_controller', 'access_networks_unleashed_set_credentials', and 'access_networks_unleashed_authenticate_controller' to wire up a controller, then 'access_networks_unleashed_request' to issue authenticated AJAX requests. Island router and Access Networks Unleashed write operations are high risk and must be used only when highly certain. Arbitrary CLI execution is never exposed. Bond local API tokens are configured only in the admin UI (/bond/setup); use bond_authentication_guide when you need a reminder.",
		},
	)

	const tools = new Map<
		string,
		{
			descriptor: HomeConnectorToolDescriptor
			handler: HomeConnectorToolHandler
		}
	>()

	function getToolResultCount(result: CallToolResult) {
		if (Array.isArray(result.content)) return result.content.length
		if (
			result.structuredContent &&
			typeof result.structuredContent === 'object' &&
			!Array.isArray(result.structuredContent)
		) {
			return Object.keys(result.structuredContent).length
		}
		return 0
	}

	function getSdkToolCallContext(
		context: unknown,
	): HomeConnectorToolCallContext {
		const raw = context as
			| {
					mcpReq?: { id?: string | number }
					sessionId?: string
					http?: { req?: unknown }
			  }
			| undefined
		return {
			requestId:
				typeof raw?.mcpReq?.id === 'string' ||
				typeof raw?.mcpReq?.id === 'number'
					? String(raw.mcpReq.id)
					: undefined,
			sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : undefined,
			transport: raw?.http?.req ? 'http' : 'stdio',
			source: 'mcp-sdk',
		}
	}

	function registerTool(
		descriptor: HomeConnectorRegisteredToolDescriptor,
		handler: HomeConnectorToolHandler,
	) {
		const instrumentedHandler: HomeConnectorToolHandler = async (
			args,
			context,
		) => {
			return await Sentry.startSpan(
				{
					op: 'mcp.server',
					name: `tools/call ${descriptor.name}`,
					forceTransaction: true,
					attributes: {
						'mcp.tool.name': descriptor.name,
						'mcp.method.name': 'tools/call',
						...(context?.requestId
							? { 'mcp.request.id': context.requestId }
							: {}),
						...(context?.sessionId
							? { 'mcp.session.id': context.sessionId }
							: {}),
						...(context?.transport
							? { 'mcp.transport': context.transport }
							: {}),
						...(context?.source
							? { 'home_connector.tool.source': context.source }
							: {}),
						'home_connector.tool.argument_count': Object.keys(args).length,
					},
				},
				async (span) => {
					try {
						const result = await handler(args, context)
						span.setAttribute(
							'mcp.tool.result.is_error',
							Boolean(result.isError),
						)
						span.setAttribute(
							'mcp.tool.result.content_count',
							getToolResultCount(result),
						)
						return result
					} catch (error) {
						span.setAttribute('mcp.tool.result.is_error', true)
						throw error
					}
				},
			)
		}
		const { sdkInputSchema, sdkOutputSchema, ...publicDescriptor } = descriptor
		tools.set(descriptor.name, {
			descriptor: publicDescriptor,
			handler: instrumentedHandler,
		})
		server.registerTool(
			descriptor.name,
			{
				title: descriptor.title,
				description: descriptor.description,
				inputSchema: sdkInputSchema ?? descriptor.inputSchema,
				...(descriptor.outputSchema
					? { outputSchema: sdkOutputSchema ?? descriptor.outputSchema }
					: {}),
				...(descriptor.annotations
					? { annotations: descriptor.annotations }
					: {}),
			},
			async (args, context) =>
				await instrumentedHandler(args, getSdkToolCallContext(context)),
		)
	}

	function playerScopedSchema(shape: Record<string, z.ZodTypeAny> = {}) {
		return buildToolInputSchema({
			playerId: z.string().min(1).optional(),
			...shape,
		})
	}

	function hasAnyValue(
		value: Record<string, unknown>,
		keys: Array<string>,
	): boolean {
		return keys.some((key) => value[key] !== undefined)
	}

	function structuredTextResult(text: string, structuredContent: unknown) {
		return {
			content: [
				{
					type: 'text' as const,
					text,
				},
			],
			structuredContent,
		}
	}

	function lutronProcessorNotFoundResult(
		error: unknown,
	): CallToolResult | null {
		if (!isLutronProcessorNotFoundError(error)) {
			return null
		}
		return {
			isError: true,
			content: [
				{
					type: 'text',
					text: error.message,
				},
			],
			structuredContent: {
				error: {
					code: 'lutron_processor_not_found',
					message: error.message,
					processorId: error.processorId,
				},
			},
		}
	}

	async function handleExpectedLutronError(
		handler: () => Promise<CallToolResult> | CallToolResult,
	) {
		try {
			return await handler()
		} catch (error) {
			const result = lutronProcessorNotFoundResult(error)
			if (result) return result
			throw error
		}
	}

	const jellyfishPatternPathSchema = buildToolInputSchema({
		patternPath: z
			.string()
			.min(1)
			.describe('Pattern path in "<folder>/<pattern name>" form.'),
		timeoutMs: z
			.number()
			.int()
			.min(250)
			.max(30_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	const jellyfishRunPatternSchema = buildToolInputSchema(
		z
			.object({
				patternPath: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Pattern path in "<folder>/<pattern name>" form for running a saved pattern.',
					),
				patternData: z
					.record(z.string(), z.any())
					.optional()
					.describe(
						'Inline pattern configuration object. Use this to run a modified or custom pattern.',
					),
				zoneNames: z
					.array(z.string().min(1))
					.optional()
					.describe(
						'Optional subset of zone names. When omitted, the controller runs the pattern on all known zones.',
					),
				state: z
					.enum(['on', 'off'])
					.optional()
					.describe('Optional state, defaulting to "on".'),
				timeoutMs: z
					.number()
					.int()
					.min(250)
					.max(30_000)
					.optional()
					.describe('Optional command timeout in milliseconds.'),
			})
			.refine(
				(value) =>
					Number(Boolean(value.patternPath)) +
						Number(Boolean(value.patternData)) ===
					1,
				{
					message:
						'Provide exactly one of patternPath or patternData for jellyfish_run_pattern.',
				},
			),
	)

	registerTool(
		{
			name: 'jellyfish_scan_controllers',
			title: 'Scan JellyFish Controllers',
			description:
				'Scan configured CIDRs for JellyFish controllers, persist any discovered controllers locally, and return discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const result = await jellyfish.scan()
			const status = jellyfish.getStatus()
			return structuredTextResult(
				result.length === 0
					? 'No JellyFish controllers were discovered.'
					: `Discovered ${result.length} JellyFish controller(s).`,
				{
					controllers: result,
					diagnostics: status.diagnostics,
				},
			)
		},
	)

	registerTool(
		{
			name: 'jellyfish_list_controllers',
			title: 'List JellyFish Controllers',
			description:
				'List persisted JellyFish controllers and their latest connectivity metadata.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const controllers = jellyfish.listControllers()
			return structuredTextResult(
				controllers.length === 0
					? 'No JellyFish controllers are currently known.'
					: controllers
							.map(
								(controller) =>
									`- ${controller.name} (${controller.hostname}) lastConnected=${controller.lastConnectedAt ?? 'never'}`,
							)
							.join('\n'),
				{
					controllers,
				},
			)
		},
	)

	registerTool(
		{
			name: 'jellyfish_list_zones',
			title: 'List JellyFish Zones',
			description:
				'List the current JellyFish zones, including zone names and pixel counts.',
			...buildToolInputSchema({
				timeoutMs: z
					.number()
					.int()
					.min(250)
					.max(30_000)
					.optional()
					.describe('Optional command timeout in milliseconds.'),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await jellyfish.listZones({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				result.zones.length === 0
					? 'No JellyFish zones were returned by the controller.'
					: `Loaded ${result.zones.length} JellyFish zone(s).`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'jellyfish_list_patterns',
			title: 'List JellyFish Patterns',
			description:
				'List runnable JellyFish patterns. Folder marker rows are filtered out so the result is ready to use.',
			...buildToolInputSchema({
				timeoutMs: z
					.number()
					.int()
					.min(250)
					.max(30_000)
					.optional()
					.describe('Optional command timeout in milliseconds.'),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await jellyfish.listPatterns({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				result.patterns.length === 0
					? 'No JellyFish patterns were returned by the controller.'
					: `Loaded ${result.patterns.length} JellyFish pattern(s).`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'jellyfish_get_pattern',
			title: 'Get JellyFish Pattern',
			description: 'Fetch and parse a saved JellyFish pattern by patternPath.',
			inputSchema: jellyfishPatternPathSchema.inputSchema,
			sdkInputSchema: jellyfishPatternPathSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await jellyfish.getPattern({
				patternPath: String(args['patternPath'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Loaded JellyFish pattern ${result.pattern.path}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'jellyfish_run_pattern',
			title: 'Run JellyFish Pattern',
			description:
				'Run a JellyFish pattern by patternPath or inline patternData. When zoneNames is omitted, the pattern runs on all known zones.',
			inputSchema: jellyfishRunPatternSchema.inputSchema,
			sdkInputSchema: jellyfishRunPatternSchema.sdkInputSchema,
		},
		async (args) => {
			const result = await jellyfish.runPattern({
				patternPath:
					args['patternPath'] == null ? undefined : String(args['patternPath']),
				patternData:
					args['patternData'] &&
					typeof args['patternData'] === 'object' &&
					!Array.isArray(args['patternData'])
						? (args['patternData'] as Record<string, unknown>)
						: undefined,
				zoneNames: Array.isArray(args['zoneNames'])
					? args['zoneNames'].map((zone) => String(zone))
					: undefined,
				state: args['state'] === 'off' ? 'off' : 'on',
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Ran JellyFish pattern on ${result.zoneNames.length} zone(s).`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'venstar_scan_thermostats',
			title: 'Scan Venstar Thermostats',
			description:
				'Probe Venstar scan CIDRs for thermostats and return discovered unmanaged devices plus discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const discovered = await venstar.scan()
			const status = venstar.getStatus()
			return structuredTextResult(
				discovered.length === 0
					? 'No Venstar thermostats were discovered.'
					: `Discovered ${discovered.length} Venstar thermostat(s).`,
				{
					discovered,
					diagnostics: status.diagnostics,
				},
			)
		},
	)

	registerTool(
		{
			name: 'venstar_add_thermostat',
			title: 'Add Venstar Thermostat',
			description:
				'Add a Venstar thermostat to managed storage, either by IP from the latest scan or by explicit name/IP.',
			...buildToolInputSchema({
				ip: z.string().min(1),
				name: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const ip = String(args['ip'])
			const name = args['name']
			const thermostat =
				name == null
					? await venstar.addDiscoveredThermostat(ip)
					: await venstar.addThermostat({
							name: String(name),
							ip,
						})
			return structuredTextResult(
				`Added ${thermostat.name} (${thermostat.ip}) to managed Venstar thermostats.`,
				{
					thermostat,
				},
			)
		},
	)

	registerTool(
		{
			name: 'venstar_remove_thermostat',
			title: 'Remove Venstar Thermostat',
			description: 'Remove a managed Venstar thermostat by IP address.',
			...buildToolInputSchema({
				ip: z.string().min(1),
			}),
		},
		async (args) => {
			const thermostat = venstar.removeThermostat(String(args['ip']))
			return structuredTextResult(
				`Removed ${thermostat.name} (${thermostat.ip}) from managed Venstar thermostats.`,
				{
					thermostat,
				},
			)
		},
	)

	registerTool(
		{
			name: 'venstar_list_thermostats',
			title: 'List Venstar Thermostats',
			description:
				'List managed Venstar thermostats with their saved name/IP and current status summary.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const thermostats = await venstar.listThermostatsWithStatus()
			return {
				content: [
					{
						type: 'text',
						text:
							thermostats.length === 0
								? 'No Venstar thermostats are managed yet.'
								: thermostats
										.map(
											(thermostat) =>
												`- ${thermostat.name} (${thermostat.ip}) mode=${thermostat.summary.mode} state=${thermostat.summary.state} temp=${thermostat.summary.spacetemp}`,
										)
										.join('\n'),
					},
				],
				structuredContent: {
					thermostats,
				},
			}
		},
	)

	registerTool(
		{
			name: 'venstar_get_thermostat_info',
			title: 'Get Venstar Thermostat Info',
			description:
				'Fetch /query/info for a Venstar thermostat (by name or IP) including mode, state, setpoints, humidity, and schedule details.',
			...buildToolInputSchema({
				thermostat: z.string().min(1).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const thermostat = args['thermostat']
			const result = await venstar.getInfo(
				thermostat == null ? undefined : String(thermostat),
			)
			return {
				content: [
					{
						type: 'text',
						text: `Fetched Venstar info for ${result.thermostat.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'venstar_get_thermostat_sensors',
			title: 'Get Venstar Thermostat Sensors',
			description:
				'Fetch /query/sensors data for a Venstar thermostat by name or IP.',
			...buildToolInputSchema({
				thermostat: z.string().min(1).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const thermostat = args['thermostat']
			const result = await venstar.getSensors(
				thermostat == null ? undefined : String(thermostat),
			)
			return {
				content: [
					{
						type: 'text',
						text: `Fetched Venstar sensors for ${result.thermostat.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'venstar_get_thermostat_runtimes',
			title: 'Get Venstar Thermostat Runtimes',
			description:
				'Fetch /query/runtimes data for a Venstar thermostat by name or IP.',
			...buildToolInputSchema({
				thermostat: z.string().min(1).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const thermostat = args['thermostat']
			const result = await venstar.getRuntimes(
				thermostat == null ? undefined : String(thermostat),
			)
			return {
				content: [
					{
						type: 'text',
						text: `Fetched Venstar runtimes for ${result.thermostat.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'venstar_control_thermostat',
			title: 'Control Venstar Thermostat',
			description:
				'POST /control to set Venstar mode, fan, heattemp, and cooltemp. In auto mode, cooltemp must exceed heattemp + setpointdelta.',
			...buildToolInputSchema(
				z
					.object({
						thermostat: z.string().min(1).optional(),
						mode: z.number().int().min(0).max(3).optional(),
						fan: z.number().int().min(0).max(1).optional(),
						heattemp: z.number().int().optional(),
						cooltemp: z.number().int().optional(),
					})
					.refine(
						(value) =>
							hasAnyValue(value, ['mode', 'fan', 'heattemp', 'cooltemp']),
						{
							message:
								'Provide at least one control change (mode, fan, heattemp, or cooltemp).',
						},
					),
			),
		},
		async (args) => {
			const result = await venstar.controlThermostat({
				thermostat:
					args['thermostat'] == null ? undefined : String(args['thermostat']),
				mode: args['mode'] == null ? undefined : Number(args['mode']),
				fan: args['fan'] == null ? undefined : Number(args['fan']),
				heattemp:
					args['heattemp'] == null ? undefined : Number(args['heattemp']),
				cooltemp:
					args['cooltemp'] == null ? undefined : Number(args['cooltemp']),
			})
			return {
				content: [
					{
						type: 'text',
						text: `Updated Venstar control settings for ${result.thermostat.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'venstar_set_thermostat_settings',
			title: 'Set Venstar Thermostat Settings',
			description:
				'POST /settings to update away mode, schedule enablement, humidity setpoints, and temperature units for a Venstar thermostat.',
			...buildToolInputSchema(
				z
					.object({
						thermostat: z.string().min(1).optional(),
						away: z.number().int().min(0).max(1).optional(),
						schedule: z.number().int().min(0).max(1).optional(),
						humidify: z.number().int().optional(),
						dehumidify: z.number().int().optional(),
						tempunits: z.number().int().min(0).max(1).optional(),
					})
					.refine(
						(value) =>
							hasAnyValue(value, [
								'away',
								'schedule',
								'humidify',
								'dehumidify',
								'tempunits',
							]),
						{
							message:
								'Provide at least one settings change (away, schedule, humidify, dehumidify, or tempunits).',
						},
					),
			),
		},
		async (args) => {
			const result = await venstar.setSettings({
				thermostat:
					args['thermostat'] == null ? undefined : String(args['thermostat']),
				away: args['away'] == null ? undefined : Number(args['away']),
				schedule:
					args['schedule'] == null ? undefined : Number(args['schedule']),
				humidify:
					args['humidify'] == null ? undefined : Number(args['humidify']),
				dehumidify:
					args['dehumidify'] == null ? undefined : Number(args['dehumidify']),
				tempunits:
					args['tempunits'] == null ? undefined : Number(args['tempunits']),
			})
			return {
				content: [
					{
						type: 'text',
						text: `Updated Venstar settings for ${result.thermostat.name}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
				key: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
				appId: z.string().min(1),
				params: z.record(z.string(), z.string()).optional(),
			}),
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

	const rokuListAppsOutputSchema = buildToolInputSchema({
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
	})

	registerTool(
		{
			name: 'roku_list_apps',
			title: 'List Roku Apps',
			description:
				'List installed Roku apps on an adopted device using the Roku ECP app query.',
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
			outputSchema: rokuListAppsOutputSchema.inputSchema,
			sdkOutputSchema: rokuListAppsOutputSchema.sdkInputSchema,
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

	const rokuActiveAppOutputSchema = buildToolInputSchema({
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
	})

	registerTool(
		{
			name: 'roku_get_active_app',
			title: 'Get Active Roku App',
			description: 'Get the currently active Roku app on an adopted device.',
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
			outputSchema: rokuActiveAppOutputSchema.inputSchema,
			sdkOutputSchema: rokuActiveAppOutputSchema.sdkInputSchema,
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
			name: 'lutron_list_processors',
			title: 'List Lutron Processors',
			description:
				'List discovered Lutron processors, whether credentials are stored, and the latest auth status.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const processors = lutron.getStatus().processors
			return {
				content: [
					{
						type: 'text',
						text:
							processors.length === 0
								? 'No Lutron processors are currently known.'
								: processors
										.map(
											(processor) =>
												`- ${processor.name} (${processor.processorId}) host=${processor.host} credentials=${String(processor.hasStoredCredentials)}`,
										)
										.join('\n'),
					},
				],
				structuredContent: {
					processors,
				},
			}
		},
	)

	registerTool(
		{
			name: 'lutron_scan_processors',
			title: 'Scan Lutron Processors',
			description:
				'Scan the local network for Lutron processors using the configured discovery mechanism.',
			inputSchema: {},
		},
		async () => {
			const processors = await lutron.scan()
			return {
				content: [
					{
						type: 'text',
						text:
							processors.length === 0
								? 'No Lutron processors discovered.'
								: `Discovered ${processors.length} Lutron processor(s).`,
					},
				],
				structuredContent: {
					processors,
				},
			}
		},
	)

	const lutronCredentialsSchema = buildToolInputSchema({
		processorId: z.string().min(1),
		username: z.string().min(1),
		password: z.string().min(1),
	})

	registerTool(
		{
			name: 'lutron_set_credentials',
			title: 'Set Lutron Credentials',
			description:
				'Associate a stored username/password with a discovered Lutron processor for LEAP login on port 8081.',
			inputSchema: markSecretInputFields(lutronCredentialsSchema.inputSchema, [
				'username',
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: lutronCredentialsSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedLutronError(() => {
				const processorId = String(args['processorId'] ?? '')
				const username = String(args['username'] ?? '')
				const password = String(args['password'] ?? '')
				const result = lutron.setCredentials(processorId, username, password)
				return {
					content: [
						{
							type: 'text',
							text: `Stored Lutron credentials for ${result.name}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_authenticate_processor',
			title: 'Authenticate Lutron Processor',
			description:
				'Attempt a LEAP login against a discovered Lutron processor using stored credentials.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const result = await lutron.authenticate(processorId)
				return {
					content: [
						{
							type: 'text',
							text: `Authenticated Lutron processor ${result.name}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_get_inventory',
			title: 'Get Lutron Inventory',
			description:
				'Read the live area, zone, control-station, and scene-button inventory from a Lutron processor.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const result = await lutron.getInventory(processorId)
				return {
					content: [
						{
							type: 'text',
							text: `Fetched Lutron inventory with ${result.zones.length} zone(s) and ${result.sceneButtons.length} scene button(s).`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_press_button',
			title: 'Press Lutron Scene Button',
			description:
				'Press a Lutron keypad button (scene-like control) using LEAP PressAndRelease.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				buttonId: z.string().min(1),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const buttonId = String(args['buttonId'] ?? '')
				const result = await lutron.pressButton(processorId, buttonId)
				return {
					content: [
						{
							type: 'text',
							text: `Pressed Lutron button ${buttonId} on processor ${processorId}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_set_zone_level',
			title: 'Set Lutron Zone Level',
			description: 'Set a Lutron zone level using LEAP GoToLevel.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				zoneId: z.string().min(1),
				level: z.number().min(0).max(100),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const zoneId = String(args['zoneId'] ?? '')
				const level = Number(args['level'] ?? 0)
				const result = await lutron.setZoneLevel(processorId, zoneId, level)
				return {
					content: [
						{
							type: 'text',
							text: `Set Lutron zone ${zoneId} to ${level}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_set_zone_color',
			title: 'Set Lutron Zone Color',
			description:
				'Set a Lutron SpectrumTune or ColorTune zone using HSV color, optionally overriding level and vibrancy.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				zoneId: z.string().min(1),
				hue: z.number().min(0).max(360),
				saturation: z.number().min(0).max(100),
				level: z.number().min(0).max(100).optional(),
				vibrancy: z.number().min(0).max(100).optional(),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const zoneId = String(args['zoneId'] ?? '')
				const hue = Number(args['hue'] ?? 0)
				const saturation = Number(args['saturation'] ?? 0)
				const level = args['level'] == null ? undefined : Number(args['level'])
				const vibrancy =
					args['vibrancy'] == null ? undefined : Number(args['vibrancy'])
				const result = await lutron.setZoneColor(processorId, zoneId, {
					hue,
					saturation,
					level,
					vibrancy,
				})
				return {
					content: [
						{
							type: 'text',
							text: `Set Lutron zone ${zoneId} to hue ${hue} saturation ${saturation}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_set_zone_white_tuning',
			title: 'Set Lutron Zone White Tuning',
			description:
				'Set a Lutron WhiteTune or SpectrumTune zone to a Kelvin temperature, optionally overriding level.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				zoneId: z.string().min(1),
				kelvin: z.number().min(1000).max(25000),
				level: z.number().min(0).max(100).optional(),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const zoneId = String(args['zoneId'] ?? '')
				const kelvin = Number(args['kelvin'] ?? 0)
				const level = args['level'] == null ? undefined : Number(args['level'])
				const result = await lutron.setZoneWhiteTuning(processorId, zoneId, {
					kelvin,
					level,
				})
				return {
					content: [
						{
							type: 'text',
							text: `Set Lutron zone ${zoneId} white tuning to ${kelvin}K.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_set_zone_switched_level',
			title: 'Set Lutron Switched Zone State',
			description:
				'Set a Lutron switched, receptacle, or other on-off zone to On or Off.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				zoneId: z.string().min(1),
				state: z.enum(['On', 'Off']),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const zoneId = String(args['zoneId'] ?? '')
				const state = args['state'] === 'Off' ? 'Off' : 'On'
				const result = await lutron.setZoneSwitchedLevel(
					processorId,
					zoneId,
					state,
				)
				return {
					content: [
						{
							type: 'text',
							text: `Set Lutron switched zone ${zoneId} to ${state}.`,
						},
					],
					structuredContent: result,
				}
			})
		},
	)

	registerTool(
		{
			name: 'lutron_set_shade_level',
			title: 'Set Lutron Shade Level',
			description:
				'Set a Lutron shade zone to a target level between 0 and 100.',
			...buildToolInputSchema({
				processorId: z.string().min(1),
				zoneId: z.string().min(1),
				level: z.number().min(0).max(100),
			}),
		},
		async (args) => {
			return await handleExpectedLutronError(async () => {
				const processorId = String(args['processorId'] ?? '')
				const zoneId = String(args['zoneId'] ?? '')
				const level = Number(args['level'] ?? 0)
				const result = await lutron.setShadeLevel(processorId, zoneId, level)
				return {
					content: [
						{
							type: 'text',
							text: `Set Lutron shade ${zoneId} to ${level}.`,
						},
					],
					structuredContent: result,
				}
			})
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
				key: z.string().min(1),
				times: z.number().int().min(1).max(20).optional(),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
				appId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
			}),
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
			...buildToolInputSchema({
				deviceId: z.string().min(1),
				mode: z.enum(['on', 'off']),
			}),
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

	registerTool(
		{
			name: 'sonos_scan_players',
			title: 'Scan Sonos Players',
			description:
				'Scan the local network for Sonos players using the configured Sonos discovery endpoint.',
			inputSchema: {},
		},
		async () => {
			const players = await sonos.scan()
			return structuredTextResult(
				players.length === 0
					? 'No Sonos players discovered.'
					: `Discovered ${players.length} Sonos player(s).`,
				{ players },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_list_players',
			title: 'List Sonos Players',
			description:
				'List known Sonos players with room names, models, group membership, and adoption state.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const players = await sonos.listPlayers()
			return structuredTextResult(
				players.length === 0
					? 'No Sonos players are currently known.'
					: players
							.map(
								(player) =>
									`- ${player.roomName} (${player.playerId}) adopted=${String(player.adopted)} group=${player.groupId ?? 'standalone'}`,
							)
							.join('\n'),
				{ players },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_adopt_player',
			title: 'Adopt Sonos Player',
			description:
				'Mark a discovered Sonos player as adopted so it becomes a managed player.',
			...buildToolInputSchema({
				playerId: z.string().min(1),
			}),
		},
		async (args) => {
			const playerId = String(args['playerId'] ?? '')
			const player = sonos.adoptPlayer(playerId)
			return structuredTextResult(
				`Adopted Sonos player ${player.roomName}.`,
				player,
			)
		},
	)

	registerTool(
		{
			name: 'sonos_list_groups',
			title: 'List Sonos Groups',
			description: 'List current Sonos groups, coordinators, and member rooms.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const groups = await sonos.listGroups(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				groups.length === 0
					? 'No Sonos groups are currently available.'
					: groups
							.map(
								(group) =>
									`- ${group.groupId}: ${group.members.map((member) => member.roomName).join(', ')}`,
							)
							.join('\n'),
				{ groups },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_get_player_status',
			title: 'Get Sonos Player Status',
			description:
				'Get transport, track, queue, volume, EQ, and input status for a Sonos player.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await sonos.getPlayerStatus(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				`${result.player.roomName} is ${result.transportState ?? 'unknown'} at volume ${String(result.volume ?? 'unknown')}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'sonos_get_group_status',
			title: 'Get Sonos Group Status',
			description: 'Get playback and membership details for a Sonos group.',
			...playerScopedSchema({
				groupId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const groupId = String(args['groupId'] ?? '')
			const result = await sonos.getGroupStatus(
				groupId,
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				`Sonos group ${groupId} is ${result.transportState ?? 'unknown'}.`,
				result,
			)
		},
	)

	const transportTools = [
		{
			name: 'sonos_play',
			title: 'Play Sonos',
			description: 'Resume playback for a Sonos player or its coordinator.',
			handler: async (playerId?: string) => {
				await sonos.play(playerId)
				return structuredTextResult('Started Sonos playback.', {
					playerId: playerId ?? null,
				})
			},
		},
		{
			name: 'sonos_pause',
			title: 'Pause Sonos',
			description: 'Pause Sonos playback.',
			handler: async (playerId?: string) => {
				await sonos.pause(playerId)
				return structuredTextResult('Paused Sonos playback.', {
					playerId: playerId ?? null,
				})
			},
		},
		{
			name: 'sonos_stop',
			title: 'Stop Sonos',
			description: 'Stop Sonos playback.',
			handler: async (playerId?: string) => {
				await sonos.stop(playerId)
				return structuredTextResult('Stopped Sonos playback.', {
					playerId: playerId ?? null,
				})
			},
		},
		{
			name: 'sonos_next_track',
			title: 'Next Sonos Track',
			description: 'Skip to the next Sonos track.',
			handler: async (playerId?: string) => {
				await sonos.nextTrack(playerId)
				return structuredTextResult('Skipped to the next Sonos track.', {
					playerId: playerId ?? null,
				})
			},
		},
		{
			name: 'sonos_previous_track',
			title: 'Previous Sonos Track',
			description: 'Go back to the previous Sonos track.',
			handler: async (playerId?: string) => {
				await sonos.previousTrack(playerId)
				return structuredTextResult('Went to the previous Sonos track.', {
					playerId: playerId ?? null,
				})
			},
		},
	] as const

	for (const tool of transportTools) {
		registerTool(
			{
				name: tool.name,
				title: tool.title,
				description: tool.description,
				...playerScopedSchema(),
			},
			async (args) =>
				await tool.handler(
					args['playerId'] == null ? undefined : String(args['playerId']),
				),
		)
	}

	registerTool(
		{
			name: 'sonos_seek',
			title: 'Seek Sonos Track',
			description: 'Seek within the current Sonos track using hh:mm:ss.',
			...playerScopedSchema({
				position: z.string().min(1),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const position = String(args['position'] ?? '')
			await sonos.seek(playerId, position)
			return structuredTextResult(`Sought Sonos playback to ${position}.`, {
				playerId: playerId ?? null,
				position,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_set_play_mode',
			title: 'Set Sonos Play Mode',
			description: 'Set the Sonos play mode for the current queue.',
			...playerScopedSchema({
				playMode: z.enum([
					'NORMAL',
					'REPEAT_ALL',
					'REPEAT_ONE',
					'SHUFFLE_NOREPEAT',
					'SHUFFLE',
					'SHUFFLE_REPEAT_ONE',
				]),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const playMode = String(args['playMode'] ?? 'NORMAL')
			await sonos.setPlayMode(playerId, playMode)
			return structuredTextResult(`Set Sonos play mode to ${playMode}.`, {
				playerId: playerId ?? null,
				playMode,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_set_volume',
			title: 'Set Sonos Volume',
			description: 'Set a Sonos player volume between 0 and 100.',
			...playerScopedSchema({
				volume: z.number().min(0).max(100),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const volume = Number(args['volume'] ?? 0)
			await sonos.setVolume(playerId, volume)
			return structuredTextResult(`Set Sonos volume to ${volume}.`, {
				playerId: playerId ?? null,
				volume,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_adjust_volume',
			title: 'Adjust Sonos Volume',
			description:
				'Adjust a Sonos player volume by a positive or negative delta.',
			...playerScopedSchema({
				delta: z.number().int().min(-100).max(100),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const delta = Number(args['delta'] ?? 0)
			await sonos.adjustVolume(playerId, delta)
			return structuredTextResult(`Adjusted Sonos volume by ${delta}.`, {
				playerId: playerId ?? null,
				delta,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_set_mute',
			title: 'Set Sonos Mute',
			description: 'Mute or unmute a Sonos player.',
			...playerScopedSchema({
				muted: z.boolean(),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const muted = Boolean(args['muted'])
			await sonos.setMute(playerId, muted)
			return structuredTextResult(
				`${muted ? 'Muted' : 'Unmuted'} Sonos playback.`,
				{
					playerId: playerId ?? null,
					muted,
				},
			)
		},
	)

	registerTool(
		{
			name: 'sonos_list_favorites',
			title: 'List Sonos Favorites',
			description: 'List Sonos favorites currently available to the household.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const favorites = await sonos.listFavorites(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				favorites.length === 0
					? 'No Sonos favorites are currently available.'
					: favorites
							.map(
								(favorite) =>
									`- ${favorite.title} (${favorite.favoriteId}) provider=${favorite.provider ?? 'unknown'}`,
							)
							.join('\n'),
				{ favorites },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_search_favorites',
			title: 'Search Sonos Favorites',
			description: 'Search Sonos favorites by title.',
			...playerScopedSchema({
				query: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const query = String(args['query'] ?? '')
			const favorites = await sonos.searchFavorites(
				query,
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				favorites.length === 0
					? `No Sonos favorites matched "${query}".`
					: `Matched ${favorites.length} Sonos favorite(s) for "${query}".`,
				{ favorites, query },
			)
		},
	)

	for (const entry of [
		{
			name: 'sonos_play_favorite',
			title: 'Play Sonos Favorite',
			description:
				'Resolve a Sonos favorite by id or title, load it into the queue, and start playback.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.playFavorite({
					playerId:
						args['playerId'] == null ? undefined : String(args['playerId']),
					favoriteId:
						args['favoriteId'] == null ? undefined : String(args['favoriteId']),
					title: args['title'] == null ? undefined : String(args['title']),
				}),
		},
		{
			name: 'sonos_enqueue_favorite',
			title: 'Enqueue Sonos Favorite',
			description:
				'Resolve a Sonos favorite by id or title and add it to the active queue.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.enqueueFavorite({
					playerId:
						args['playerId'] == null ? undefined : String(args['playerId']),
					favoriteId:
						args['favoriteId'] == null ? undefined : String(args['favoriteId']),
					title: args['title'] == null ? undefined : String(args['title']),
				}),
		},
	] as const) {
		registerTool(
			{
				name: entry.name,
				title: entry.title,
				description: entry.description,
				...playerScopedSchema({
					favoriteId: z.string().min(1).optional(),
					title: z.string().min(1).optional(),
				}),
			},
			async (args) => {
				const favorite = await entry.handler(args)
				return structuredTextResult(`${entry.title} completed.`, {
					favorite,
				})
			},
		)
	}

	registerTool(
		{
			name: 'sonos_list_saved_queues',
			title: 'List Sonos Saved Queues',
			description: 'List Sonos saved queues.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const savedQueues = await sonos.listSavedQueues(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				savedQueues.length === 0
					? 'No Sonos saved queues are currently available.'
					: savedQueues
							.map(
								(savedQueue) =>
									`- ${savedQueue.title} (${savedQueue.savedQueueId})`,
							)
							.join('\n'),
				{ savedQueues },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_search_saved_queues',
			title: 'Search Sonos Saved Queues',
			description: 'Search Sonos saved queues by title.',
			...playerScopedSchema({
				query: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const query = String(args['query'] ?? '')
			const savedQueues = await sonos.searchSavedQueues(
				query,
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				savedQueues.length === 0
					? `No Sonos saved queues matched "${query}".`
					: `Matched ${savedQueues.length} Sonos saved queue(s) for "${query}".`,
				{ savedQueues, query },
			)
		},
	)

	for (const entry of [
		{
			name: 'sonos_play_saved_queue',
			title: 'Play Sonos Saved Queue',
			description:
				'Resolve a Sonos saved queue by id or title, load it into the active queue, and start playback.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.playSavedQueue({
					playerId:
						args['playerId'] == null ? undefined : String(args['playerId']),
					savedQueueId:
						args['savedQueueId'] == null
							? undefined
							: String(args['savedQueueId']),
					title: args['title'] == null ? undefined : String(args['title']),
				}),
		},
		{
			name: 'sonos_enqueue_saved_queue',
			title: 'Enqueue Sonos Saved Queue',
			description:
				'Resolve a Sonos saved queue by id or title and add it to the active queue.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.enqueueSavedQueue({
					playerId:
						args['playerId'] == null ? undefined : String(args['playerId']),
					savedQueueId:
						args['savedQueueId'] == null
							? undefined
							: String(args['savedQueueId']),
					title: args['title'] == null ? undefined : String(args['title']),
				}),
		},
	] as const) {
		registerTool(
			{
				name: entry.name,
				title: entry.title,
				description: entry.description,
				...playerScopedSchema({
					savedQueueId: z.string().min(1).optional(),
					title: z.string().min(1).optional(),
				}),
			},
			async (args) => {
				const savedQueue = await entry.handler(args)
				return structuredTextResult(`${entry.title} completed.`, {
					savedQueue,
				})
			},
		)
	}

	registerTool(
		{
			name: 'sonos_list_queue',
			title: 'List Sonos Queue',
			description: 'List the active Sonos queue for a player.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const queue = await sonos.listQueue(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult(
				queue.length === 0
					? 'The Sonos queue is empty.'
					: queue
							.map(
								(track) =>
									`${track.position}. ${track.title ?? 'Unknown'} (${track.queueItemId})`,
							)
							.join('\n'),
				{ queue },
			)
		},
	)

	registerTool(
		{
			name: 'sonos_clear_queue',
			title: 'Clear Sonos Queue',
			description: 'Remove all items from the active Sonos queue.',
			...playerScopedSchema(),
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			await sonos.clearQueue(playerId)
			return structuredTextResult('Cleared the Sonos queue.', {
				playerId: playerId ?? null,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_remove_queue_track',
			title: 'Remove Sonos Queue Track',
			description:
				'Remove a single item from the active Sonos queue by queueItemId or 1-based position.',
			...playerScopedSchema({
				queueItemId: z.string().min(1).optional(),
				position: z.number().int().min(1).optional(),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const queueItemId =
				args['queueItemId'] == null ? undefined : String(args['queueItemId'])
			const position =
				args['position'] == null ? undefined : Number(args['position'])
			await sonos.removeQueueTrack({
				playerId,
				queueItemId,
				position,
			})
			return structuredTextResult('Removed the requested Sonos queue track.', {
				playerId: playerId ?? null,
				queueItemId: queueItemId ?? null,
				position: position ?? null,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_group_players',
			title: 'Group Sonos Players',
			description: 'Join a Sonos player to another player’s group coordinator.',
			...buildToolInputSchema({
				playerId: z.string().min(1),
				coordinatorPlayerId: z.string().min(1),
			}),
		},
		async (args) => {
			const playerId = String(args['playerId'] ?? '')
			const coordinatorPlayerId = String(args['coordinatorPlayerId'] ?? '')
			await sonos.groupPlayers({
				playerId,
				coordinatorPlayerId,
			})
			return structuredTextResult('Grouped the Sonos players.', {
				playerId,
				coordinatorPlayerId,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_ungroup_player',
			title: 'Ungroup Sonos Player',
			description:
				'Remove a Sonos player from its current group and make it standalone.',
			...buildToolInputSchema({
				playerId: z.string().min(1),
			}),
		},
		async (args) => {
			const playerId = String(args['playerId'] ?? '')
			await sonos.ungroupPlayer(playerId)
			return structuredTextResult('Ungrouped the Sonos player.', {
				playerId,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_get_audio_input',
			title: 'Get Sonos Audio Input',
			description:
				'Get line-in details for a Sonos player that supports audio input.',
			...playerScopedSchema(),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await sonos.getAudioInput(
				args['playerId'] == null ? undefined : String(args['playerId']),
			)
			return structuredTextResult('Fetched Sonos audio input status.', result)
		},
	)

	registerTool(
		{
			name: 'sonos_select_audio_input',
			title: 'Select Sonos Audio Input',
			description: 'Switch a Sonos player to its line-in audio input.',
			...playerScopedSchema(),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			await sonos.selectAudioInput(playerId)
			return structuredTextResult('Selected the Sonos audio input.', {
				playerId: playerId ?? null,
			})
		},
	)

	registerTool(
		{
			name: 'sonos_set_line_in_level',
			title: 'Set Sonos Line-In Level',
			description:
				'Set the line-in input level for a Sonos player with audio input support.',
			...playerScopedSchema({
				level: z.number().int().min(0).max(10),
				rightLevel: z.number().int().min(0).max(10).optional(),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const level = Number(args['level'] ?? 0)
			const rightLevel =
				args['rightLevel'] == null ? level : Number(args['rightLevel'])
			await sonos.setLineInLevel(playerId, level, rightLevel)
			return structuredTextResult('Updated the Sonos line-in level.', {
				playerId: playerId ?? null,
				leftLevel: level,
				rightLevel,
			})
		},
	)

	for (const entry of [
		{
			name: 'sonos_start_line_in_to_group',
			title: 'Start Sonos Line-In To Group',
			description:
				'Transmit a Sonos player line-in source to the specified group coordinator.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.startLineInToGroup({
					sourcePlayerId: String(args['sourcePlayerId'] ?? ''),
					coordinatorPlayerId: String(args['coordinatorPlayerId'] ?? ''),
				}),
		},
		{
			name: 'sonos_stop_line_in_to_group',
			title: 'Stop Sonos Line-In To Group',
			description:
				'Stop transmitting a Sonos player line-in source to the specified group coordinator.',
			handler: async (args: Record<string, unknown>) =>
				await sonos.stopLineInToGroup({
					sourcePlayerId: String(args['sourcePlayerId'] ?? ''),
					coordinatorPlayerId: String(args['coordinatorPlayerId'] ?? ''),
				}),
		},
	] as const) {
		registerTool(
			{
				name: entry.name,
				title: entry.title,
				description: entry.description,
				...buildToolInputSchema({
					sourcePlayerId: z.string().min(1),
					coordinatorPlayerId: z.string().min(1),
				}),
			},
			async (args) => {
				await entry.handler(args)
				return structuredTextResult(`${entry.title} completed.`, {
					sourcePlayerId: String(args['sourcePlayerId'] ?? ''),
					coordinatorPlayerId: String(args['coordinatorPlayerId'] ?? ''),
				})
			},
		)
	}

	registerTool(
		{
			name: 'sonos_search_local_library',
			title: 'Search Sonos Local Library',
			description:
				'Search the Sonos local library across artists, albums, and tracks.',
			...playerScopedSchema({
				query: z.string().min(1),
				category: z.enum(['artists', 'albums', 'tracks']).optional(),
				limit: z.number().int().min(1).max(1000).optional(),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await sonos.searchLocalLibrary({
				query: String(args['query'] ?? ''),
				playerId:
					args['playerId'] == null ? undefined : String(args['playerId']),
				category:
					args['category'] == null
						? undefined
						: (String(args['category']) as 'artists' | 'albums' | 'tracks'),
				limit: args['limit'] == null ? undefined : Number(args['limit']),
			})
			return structuredTextResult('Searched the Sonos local library.', {
				result,
			})
		},
	)

	for (const entry of [
		{
			name: 'sonos_list_library_artists',
			title: 'List Sonos Library Artists',
			category: 'artists' as const,
		},
		{
			name: 'sonos_list_library_albums',
			title: 'List Sonos Library Albums',
			category: 'albums' as const,
		},
		{
			name: 'sonos_list_library_tracks',
			title: 'List Sonos Library Tracks',
			category: 'tracks' as const,
		},
	] as const) {
		registerTool(
			{
				name: entry.name,
				title: entry.title,
				description: `${entry.title} from the Sonos local library, optionally filtering by a query string.`,
				...playerScopedSchema({
					query: z.string().min(1).optional(),
					limit: z.number().int().min(1).max(1000).optional(),
				}),
				annotations: {
					readOnlyHint: true,
				},
			},
			async (args) => {
				const items =
					entry.category === 'artists'
						? await sonos.listLibraryArtists(
								args['playerId'] == null ? undefined : String(args['playerId']),
								args['query'] == null ? undefined : String(args['query']),
								args['limit'] == null ? undefined : Number(args['limit']),
							)
						: entry.category === 'albums'
							? await sonos.listLibraryAlbums(
									args['playerId'] == null
										? undefined
										: String(args['playerId']),
									args['query'] == null ? undefined : String(args['query']),
									args['limit'] == null ? undefined : Number(args['limit']),
								)
							: await sonos.listLibraryTracks(
									args['playerId'] == null
										? undefined
										: String(args['playerId']),
									args['query'] == null ? undefined : String(args['query']),
									args['limit'] == null ? undefined : Number(args['limit']),
								)
				return structuredTextResult(
					items.length === 0
						? `${entry.title} returned no results.`
						: `${entry.title} returned ${items.length} item(s).`,
					{ items },
				)
			},
		)
	}

	registerTool(
		{
			name: 'sonos_play_uri',
			title: 'Play Sonos URI',
			description:
				'Set a Sonos player transport URI directly and start playback.',
			...playerScopedSchema({
				uri: z.string().min(1),
				metadata: z.string().optional(),
				title: z.string().optional(),
				artist: z.string().optional(),
				album: z.string().optional(),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			await sonos.playUri({
				playerId,
				uri: String(args['uri'] ?? ''),
				metadata:
					args['metadata'] == null ? undefined : String(args['metadata']),
				title: args['title'] == null ? undefined : String(args['title']),
				artist: args['artist'] == null ? undefined : String(args['artist']),
				album: args['album'] == null ? undefined : String(args['album']),
			})
			return structuredTextResult(
				'Started playback from the provided Sonos URI.',
				{
					playerId: playerId ?? null,
					uri: String(args['uri'] ?? ''),
				},
			)
		},
	)

	for (const entry of [
		{
			name: 'sonos_set_bass',
			title: 'Set Sonos Bass',
			field: 'bass',
			handler: async (playerId: string | undefined, value: number) =>
				await sonos.setBass(playerId, value),
		},
		{
			name: 'sonos_set_treble',
			title: 'Set Sonos Treble',
			field: 'treble',
			handler: async (playerId: string | undefined, value: number) =>
				await sonos.setTreble(playerId, value),
		},
	] as const) {
		registerTool(
			{
				name: entry.name,
				title: entry.title,
				description: `${entry.title} between -10 and 10.`,
				...playerScopedSchema({
					value: z.number().int().min(-10).max(10),
				}),
			},
			async (args) => {
				const playerId =
					args['playerId'] == null ? undefined : String(args['playerId'])
				const value = Number(args['value'] ?? 0)
				await entry.handler(playerId, value)
				return structuredTextResult(`${entry.title} updated.`, {
					playerId: playerId ?? null,
					value,
				})
			},
		)
	}

	registerTool(
		{
			name: 'sonos_set_loudness',
			title: 'Set Sonos Loudness',
			description: 'Enable or disable Sonos loudness compensation.',
			...playerScopedSchema({
				loudness: z.boolean(),
			}),
		},
		async (args) => {
			const playerId =
				args['playerId'] == null ? undefined : String(args['playerId'])
			const loudness = Boolean(args['loudness'])
			await sonos.setLoudness(playerId, loudness)
			return structuredTextResult('Updated Sonos loudness.', {
				playerId: playerId ?? null,
				loudness,
			})
		},
	)

	registerBondHomeConnectorTools({
		registerTool,
		bond,
		config: input.config,
	})

	registerIslandRouterHomeConnectorTools({
		registerTool,
		islandRouter,
	})

	registerAccessNetworksUnleashedHomeConnectorTools({
		registerTool,
		accessNetworksUnleashed,
	})

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
				call(name, args = {}, context) {
					const tool = tools.get(name)
					if (!tool) {
						throw new Error(`Unknown connector tool "${name}".`)
					}
					return tool.handler(args, context)
				},
			}
		},
	}
}
