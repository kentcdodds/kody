import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { type createAccessNetworksUnleashedAdapter } from '../adapters/access-networks-unleashed/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type AccessNetworksUnleashedToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type AccessNetworksUnleashedRegisteredToolDescriptor =
	AccessNetworksUnleashedToolDescriptor & {
		sdkInputSchema?: ToolInputSchema
	}

type AccessNetworksUnleashedToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function structuredTextResult(
	text: string,
	structuredContent: unknown,
): CallToolResult {
	return {
		content: [
			{
				type: 'text',
				text,
			},
		],
		structuredContent,
	}
}

const unleashedWriteDangerNotice =
	'HIGH RISK: this mutates a live Access Networks Unleashed WiFi system. Use it only when you are highly certain it is necessary and correct because mistakes can disconnect clients, take SSIDs offline, reboot access points, or disrupt local connectivity.'

function createUnleashedWriteSchema(confirmationPhrase: string) {
	return {
		acknowledgeHighRisk: z
			.literal(true)
			.describe(
				'Must be true. Set this only when you are highly certain the requested WiFi mutation is necessary and correct.',
			),
		reason: z
			.string()
			.min(20)
			.max(500)
			.describe(
				'Short operator justification. Be specific about why this mutation is necessary right now.',
			),
		confirmation: z
			.literal(confirmationPhrase)
			.describe(
				'Exact confirmation phrase required by the tool. The tool rejects any other value.',
			),
	}
}

function registerUnleashedReadTool(input: {
	registerTool: (
		descriptor: AccessNetworksUnleashedRegisteredToolDescriptor,
		handler: AccessNetworksUnleashedToolHandler,
	) => void
	name: string
	title: string
	description: string
	inputSchema?: ReturnType<typeof buildToolInputSchema>
	handler: (args: Record<string, unknown>) => Promise<{
		text: string
		structuredContent: unknown
	}>
}) {
	input.registerTool(
		{
			name: input.name,
			title: input.title,
			description: input.description,
			inputSchema: input.inputSchema?.inputSchema ?? {},
			sdkInputSchema: input.inputSchema?.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await input.handler(args)
			return structuredTextResult(result.text, result.structuredContent)
		},
	)
}

export function registerAccessNetworksUnleashedHomeConnectorTools(input: {
	registerTool: (
		descriptor: AccessNetworksUnleashedRegisteredToolDescriptor,
		handler: AccessNetworksUnleashedToolHandler,
	) => void
	accessNetworksUnleashed: ReturnType<
		typeof createAccessNetworksUnleashedAdapter
	>
}) {
	const { registerTool, accessNetworksUnleashed } = input

	registerTool(
		{
			name: 'access_networks_unleashed_scan_controllers',
			title: 'Scan Access Networks Unleashed Controllers',
			description:
				'Probe local-network scan CIDRs for Access Networks / RUCKUS Unleashed controllers, persist discovered controllers locally, and return discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const controllers = await accessNetworksUnleashed.scan()
			return structuredTextResult(
				controllers.length === 0
					? 'No Access Networks Unleashed controllers were discovered.'
					: `Discovered ${controllers.length} Access Networks Unleashed controller(s).`,
				{
					controllers,
					diagnostics: accessNetworksUnleashed.getStatus().then
						? undefined
						: undefined,
				},
			)
		},
	)

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_controllers',
		title: 'List Access Networks Unleashed Controllers',
		description:
			'List locally persisted Access Networks Unleashed controllers, whether one is adopted, and whether credentials are stored.',
		handler: async () => {
			const controllers = accessNetworksUnleashed.listControllers()
			return {
				text:
					controllers.length === 0
						? 'No Access Networks Unleashed controllers are currently known.'
						: controllers
								.map(
									(controller) =>
										`- ${controller.name} (${controller.controllerId}) adopted=${String(controller.adopted)} credentials=${String(controller.hasStoredCredentials)}`,
								)
								.join('\n'),
				structuredContent: {
					controllers,
				},
			}
		},
	})

	const controllerIdSchema = buildToolInputSchema({
		controllerId: z.string().min(1),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_adopt_controller',
			title: 'Adopt Access Networks Unleashed Controller',
			description:
				'Mark a discovered Access Networks Unleashed controller as the adopted controller for live reads and write operations.',
			inputSchema: controllerIdSchema.inputSchema,
			sdkInputSchema: controllerIdSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = accessNetworksUnleashed.adoptController({
				controllerId: String(args['controllerId'] ?? ''),
			})
			return structuredTextResult(
				`Adopted Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_remove_controller',
			title: 'Remove Access Networks Unleashed Controller',
			description:
				'Remove a locally persisted Access Networks Unleashed controller and any stored credentials.',
			inputSchema: controllerIdSchema.inputSchema,
			sdkInputSchema: controllerIdSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = accessNetworksUnleashed.removeController({
				controllerId: String(args['controllerId'] ?? ''),
			})
			return structuredTextResult(
				`Removed Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	const credentialsSchema = buildToolInputSchema({
		controllerId: z.string().min(1),
		username: z.string().min(1),
		password: z.string().min(1),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_set_credentials',
			title: 'Set Access Networks Unleashed Credentials',
			description:
				'Store username/password locally for an Access Networks Unleashed controller so the connector can authenticate later.',
			inputSchema: markSecretInputFields(credentialsSchema.inputSchema, [
				'username',
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: credentialsSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = accessNetworksUnleashed.setCredentials({
				controllerId: String(args['controllerId'] ?? ''),
				username: String(args['username'] ?? ''),
				password: String(args['password'] ?? ''),
			})
			return structuredTextResult(
				`Stored Access Networks Unleashed credentials for ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_authenticate_controller',
			title: 'Authenticate Access Networks Unleashed Controller',
			description:
				'Attempt an Access Networks Unleashed login using stored credentials for the adopted controller or the specified controller.',
			...buildToolInputSchema({
				controllerId: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const controller = await accessNetworksUnleashed.authenticate(
				args['controllerId'] == null ? undefined : String(args['controllerId']),
			)
			return structuredTextResult(
				`Authenticated Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_status',
		title: 'Get Access Networks Unleashed Status',
		description:
			'Read-only Access Networks Unleashed status summary including adopted-controller readiness, discovery diagnostics, system info, access points, WLANs, active clients, and recent events.',
		handler: async () => {
			const status = await accessNetworksUnleashed.getStatus()
			return {
				text: status.config.configured
					? `Access Networks Unleashed status loaded with ${status.aps.length} AP(s), ${status.wlans.length} WLAN(s), and ${status.clients.length} active client(s).`
					: `Access Networks Unleashed is not fully configured: ${status.config.missingRequirements.join(', ')}.`,
				structuredContent: status,
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_access_points',
		title: 'List Access Networks Unleashed Access Points',
		description:
			'Read access point inventory and statistics from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const aps = await accessNetworksUnleashed.listAccessPoints()
			return {
				text: `Loaded ${aps.length} Access Networks Unleashed access point(s).`,
				structuredContent: { aps },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_clients',
		title: 'List Access Networks Unleashed Clients',
		description:
			'Read currently active wireless clients from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const clients = await accessNetworksUnleashed.listClients()
			return {
				text: `Loaded ${clients.length} Access Networks Unleashed active client(s).`,
				structuredContent: { clients },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_wlans',
		title: 'List Access Networks Unleashed WLANs',
		description:
			'Read WLAN/SSID configuration from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const wlans = await accessNetworksUnleashed.listWlans()
			return {
				text: `Loaded ${wlans.length} Access Networks Unleashed WLAN(s).`,
				structuredContent: { wlans },
			}
		},
	})

	const eventsSchema = buildToolInputSchema({
		limit: z
			.number()
			.int()
			.min(1)
			.max(300)
			.optional()
			.describe('Maximum number of recent events to return.'),
	})
	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_events',
		title: 'List Access Networks Unleashed Events',
		description:
			'Read recent controller events from the configured Access Networks Unleashed controller.',
		inputSchema: eventsSchema,
		handler: async (args) => {
			const events = await accessNetworksUnleashed.listEvents(
				args['limit'] == null ? undefined : Number(args['limit']),
			)
			return {
				text: `Loaded ${events.length} Access Networks Unleashed event(s).`,
				structuredContent: { events },
			}
		},
	})

	const clientMutationSchema = (confirmationPhrase: string, target: string) =>
		buildToolInputSchema({
			macAddress: z.string().min(1).describe(target),
			...createUnleashedWriteSchema(confirmationPhrase),
		})
	const blockClientSchema = clientMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.blockClient,
		'Client MAC address to block.',
	)
	const unblockClientSchema = clientMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.unblockClient,
		'Client MAC address to unblock.',
	)

	registerTool(
		{
			name: 'access_networks_unleashed_block_client',
			title: 'Block Access Networks Unleashed Client',
			description: `${unleashedWriteDangerNotice} This typed operation blocks a wireless client by MAC address.`,
			inputSchema: blockClientSchema.inputSchema,
			sdkInputSchema: blockClientSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.blockClient({
				macAddress: String(args['macAddress'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Blocked Access Networks Unleashed client ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_unblock_client',
			title: 'Unblock Access Networks Unleashed Client',
			description: `${unleashedWriteDangerNotice} This typed operation removes a wireless client block by MAC address.`,
			inputSchema: unblockClientSchema.inputSchema,
			sdkInputSchema: unblockClientSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.unblockClient({
				macAddress: String(args['macAddress'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Unblocked Access Networks Unleashed client ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)

	const wlanMutationSchema = (confirmationPhrase: string) =>
		buildToolInputSchema({
			name: z.string().min(1).describe('WLAN/SSID service name to mutate.'),
			...createUnleashedWriteSchema(confirmationPhrase),
		})
	const enableWlanSchema = wlanMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.enableWlan,
	)
	const disableWlanSchema = wlanMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.disableWlan,
	)

	registerTool(
		{
			name: 'access_networks_unleashed_enable_wlan',
			title: 'Enable Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation enables a WLAN/SSID by name.`,
			inputSchema: enableWlanSchema.inputSchema,
			sdkInputSchema: enableWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.enableWlan({
				name: String(args['name'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Enabled Access Networks Unleashed WLAN ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_disable_wlan',
			title: 'Disable Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation disables a WLAN/SSID by name. It can immediately disconnect every client on that SSID.`,
			inputSchema: disableWlanSchema.inputSchema,
			sdkInputSchema: disableWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.disableWlan({
				name: String(args['name'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Disabled Access Networks Unleashed WLAN ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	const apMutationSchema = (confirmationPhrase: string, ledControl = false) =>
		buildToolInputSchema({
			macAddress: z.string().min(1).describe('Access point MAC address.'),
			...(ledControl
				? {
						enabled: z
							.boolean()
							.describe('True to show AP LEDs, false to turn AP LEDs off.'),
					}
				: {}),
			...createUnleashedWriteSchema(confirmationPhrase),
		})
	const restartApSchema = apMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.restartAccessPoint,
	)
	const setApLedsSchema = apMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.setAccessPointLeds,
		true,
	)

	registerTool(
		{
			name: 'access_networks_unleashed_restart_access_point',
			title: 'Restart Access Networks Unleashed Access Point',
			description: `${unleashedWriteDangerNotice} This typed operation reboots an access point by MAC address and can immediately disconnect associated clients.`,
			inputSchema: restartApSchema.inputSchema,
			sdkInputSchema: restartApSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.restartAccessPoint({
				macAddress: String(args['macAddress'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Restarted Access Networks Unleashed access point ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_set_access_point_leds',
			title: 'Set Access Networks Unleashed Access Point LEDs',
			description: `${unleashedWriteDangerNotice} This typed operation changes access point LED visibility by MAC address.`,
			inputSchema: setApLedsSchema.inputSchema,
			sdkInputSchema: setApLedsSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.setAccessPointLeds({
				macAddress: String(args['macAddress'] ?? ''),
				enabled: args['enabled'] === true,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Updated Access Networks Unleashed access point LEDs for ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)
}
