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
					diagnostics: accessNetworksUnleashed.getDiscoveryDiagnostics(),
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

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_blocked_clients',
		title: 'List Access Networks Unleashed Blocked Clients',
		description:
			'Read the Access Networks Unleashed system ACL blocklist of MAC addresses currently blocked from associating.',
		handler: async () => {
			const clients = await accessNetworksUnleashed.listBlockedClients()
			return {
				text: `Loaded ${clients.length} Access Networks Unleashed blocked client(s).`,
				structuredContent: { clients },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_inactive_clients',
		title: 'List Access Networks Unleashed Inactive Clients',
		description:
			'Read historical/inactive wireless clients from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const clients = await accessNetworksUnleashed.listInactiveClients()
			return {
				text: `Loaded ${clients.length} Access Networks Unleashed inactive client(s).`,
				structuredContent: { clients },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_active_rogues',
		title: 'List Access Networks Unleashed Active Rogues',
		description:
			'Read currently detected rogue access points from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const rogues = await accessNetworksUnleashed.listActiveRogues()
			return {
				text: `Loaded ${rogues.length} Access Networks Unleashed active rogue(s).`,
				structuredContent: { rogues },
			}
		},
	})

	const rogueLimitSchema = buildToolInputSchema({
		limit: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe('Maximum number of rogues to return.'),
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_known_rogues',
		title: 'List Access Networks Unleashed Known Rogues',
		description:
			'Read recognized/acknowledged rogue access points from the configured Access Networks Unleashed controller.',
		inputSchema: rogueLimitSchema,
		handler: async (args) => {
			const rogues = await accessNetworksUnleashed.listKnownRogues(
				args['limit'] == null ? undefined : Number(args['limit']),
			)
			return {
				text: `Loaded ${rogues.length} Access Networks Unleashed known rogue(s).`,
				structuredContent: { rogues },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_blocked_rogues',
		title: 'List Access Networks Unleashed Blocked Rogues',
		description:
			'Read user-blocked rogue access points from the configured Access Networks Unleashed controller.',
		inputSchema: rogueLimitSchema,
		handler: async (args) => {
			const rogues = await accessNetworksUnleashed.listBlockedRogues(
				args['limit'] == null ? undefined : Number(args['limit']),
			)
			return {
				text: `Loaded ${rogues.length} Access Networks Unleashed blocked rogue(s).`,
				structuredContent: { rogues },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_ap_groups',
		title: 'List Access Networks Unleashed AP Groups',
		description:
			'Read AP group configuration from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const apGroups = await accessNetworksUnleashed.listApGroups()
			return {
				text: `Loaded ${apGroups.length} Access Networks Unleashed AP group(s).`,
				structuredContent: { apGroups },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_list_dpsks',
		title: 'List Access Networks Unleashed DPSKs',
		description:
			'Read Dynamic PSK (DPSK) configuration from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const dpsks = await accessNetworksUnleashed.listDpsks()
			return {
				text: `Loaded ${dpsks.length} Access Networks Unleashed DPSK(s).`,
				structuredContent: { dpsks },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_mesh_info',
		title: 'Get Access Networks Unleashed Mesh Info',
		description:
			'Read mesh topology information from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const mesh = await accessNetworksUnleashed.getMeshInfo()
			return {
				text: 'Loaded Access Networks Unleashed mesh information.',
				structuredContent: { mesh },
			}
		},
	})

	const alarmsSchema = buildToolInputSchema({
		limit: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe('Maximum number of active alarms to return.'),
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_alarms',
		title: 'Get Access Networks Unleashed Alarms',
		description:
			'Read active alarms from the configured Access Networks Unleashed controller. Alarms are reported separately from controller events.',
		inputSchema: alarmsSchema,
		handler: async (args) => {
			const alarms = await accessNetworksUnleashed.getAlarms(
				args['limit'] == null ? undefined : Number(args['limit']),
			)
			return {
				text: `Loaded ${alarms.length} Access Networks Unleashed alarm(s).`,
				structuredContent: { alarms },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_syslog',
		title: 'Get Access Networks Unleashed Syslog',
		description:
			'Read raw system syslog text from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const syslog = await accessNetworksUnleashed.getSyslog()
			return {
				text: `Loaded ${syslog.length} character(s) of Access Networks Unleashed syslog.`,
				structuredContent: { syslog },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_vap_stats',
		title: 'Get Access Networks Unleashed VAP Stats',
		description:
			'Read per-VAP (per-radio-WLAN) throughput statistics from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const vaps = await accessNetworksUnleashed.getVapStats()
			return {
				text: `Loaded ${vaps.length} Access Networks Unleashed VAP statistic record(s).`,
				structuredContent: { vaps },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_wlan_group_stats',
		title: 'Get Access Networks Unleashed WLAN Group Stats',
		description:
			'Read per-WLAN-group statistics from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const wlanGroups = await accessNetworksUnleashed.getWlanGroupStats()
			return {
				text: `Loaded ${wlanGroups.length} Access Networks Unleashed WLAN group statistic record(s).`,
				structuredContent: { wlanGroups },
			}
		},
	})

	registerUnleashedReadTool({
		registerTool,
		name: 'access_networks_unleashed_get_ap_group_stats',
		title: 'Get Access Networks Unleashed AP Group Stats',
		description:
			'Read per-AP-group statistics from the configured Access Networks Unleashed controller.',
		handler: async () => {
			const apGroups = await accessNetworksUnleashed.getApGroupStats()
			return {
				text: `Loaded ${apGroups.length} Access Networks Unleashed AP group statistic record(s).`,
				structuredContent: { apGroups },
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

	const hideApLedsSchema = apMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.hideAccessPointLeds,
	)
	const showApLedsSchema = apMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.showAccessPointLeds,
	)

	registerTool(
		{
			name: 'access_networks_unleashed_hide_ap_leds',
			title: 'Hide Access Networks Unleashed Access Point LEDs',
			description: `${unleashedWriteDangerNotice} This typed operation turns OFF the LEDs on a single access point by MAC address.`,
			inputSchema: hideApLedsSchema.inputSchema,
			sdkInputSchema: hideApLedsSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.hideAccessPointLeds({
				macAddress: String(args['macAddress'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Hid Access Networks Unleashed access point LEDs for ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_show_ap_leds',
			title: 'Show Access Networks Unleashed Access Point LEDs',
			description: `${unleashedWriteDangerNotice} This typed operation turns ON the LEDs on a single access point by MAC address.`,
			inputSchema: showApLedsSchema.inputSchema,
			sdkInputSchema: showApLedsSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.showAccessPointLeds({
				macAddress: String(args['macAddress'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Showed Access Networks Unleashed access point LEDs for ${String(args['macAddress'] ?? '')}.`,
				result,
			)
		},
	)

	const setWlanPasswordSchema = buildToolInputSchema({
		name: z.string().min(1).describe('WLAN/SSID service name to update.'),
		password: z
			.string()
			.min(1)
			.describe('New WPA2 passphrase for the WLAN.'),
		saePassphrase: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional WPA3 SAE passphrase. If omitted, the same value as password is used.',
			),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.setWlanPassword,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_set_wlan_password',
			title: 'Set Access Networks Unleashed WLAN Password',
			description: `${unleashedWriteDangerNotice} This typed operation changes the WPA passphrase on an existing WLAN by name and may force every connected client on that SSID to reconnect.`,
			inputSchema: markSecretInputFields(setWlanPasswordSchema.inputSchema, [
				'password',
				'saePassphrase',
			]) as Record<string, unknown>,
			sdkInputSchema: setWlanPasswordSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.setWlanPassword({
				name: String(args['name'] ?? ''),
				password: String(args['password'] ?? ''),
				saePassphrase:
					args['saePassphrase'] == null
						? undefined
						: String(args['saePassphrase']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Updated Access Networks Unleashed WLAN passphrase for ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	const addWlanSchema = buildToolInputSchema({
		ssid: z.string().min(1).describe('SSID for the new WLAN.'),
		passphrase: z
			.string()
			.min(1)
			.describe('WPA2 passphrase for the new WLAN.'),
		name: z
			.string()
			.min(1)
			.optional()
			.describe('Optional WLAN service name. Defaults to the SSID.'),
		saePassphrase: z
			.string()
			.min(1)
			.optional()
			.describe('Optional WPA3 SAE passphrase. Defaults to passphrase.'),
		description: z
			.string()
			.optional()
			.describe('Optional human-readable WLAN description.'),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.addWlan,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_add_wlan',
			title: 'Add Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation creates a new WLAN/SSID on the controller. New WLANs are immediately broadcast on every member access point.`,
			inputSchema: markSecretInputFields(addWlanSchema.inputSchema, [
				'passphrase',
				'saePassphrase',
			]) as Record<string, unknown>,
			sdkInputSchema: addWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.addWlan({
				ssid: String(args['ssid'] ?? ''),
				passphrase: String(args['passphrase'] ?? ''),
				name: args['name'] == null ? undefined : String(args['name']),
				saePassphrase:
					args['saePassphrase'] == null
						? undefined
						: String(args['saePassphrase']),
				description:
					args['description'] == null
						? undefined
						: String(args['description']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Added Access Networks Unleashed WLAN ${String(args['ssid'] ?? '')}.`,
				result,
			)
		},
	)

	const editWlanSchema = buildToolInputSchema({
		name: z
			.string()
			.min(1)
			.describe('WLAN/SSID service name of the WLAN to edit.'),
		passphrase: z
			.string()
			.min(1)
			.optional()
			.describe('Optional new WPA2 passphrase.'),
		saePassphrase: z
			.string()
			.min(1)
			.optional()
			.describe('Optional new WPA3 SAE passphrase.'),
		ssid: z
			.string()
			.min(1)
			.optional()
			.describe('Optional new SSID broadcast value.'),
		description: z.string().optional().describe('Optional new WLAN description.'),
		enabled: z
			.boolean()
			.optional()
			.describe('Optional enabled flag. true enables the WLAN, false disables it.'),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.editWlan,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_edit_wlan',
			title: 'Edit Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation modifies an existing WLAN by name. Provide only the fields you want to change.`,
			inputSchema: markSecretInputFields(editWlanSchema.inputSchema, [
				'passphrase',
				'saePassphrase',
			]) as Record<string, unknown>,
			sdkInputSchema: editWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.editWlan({
				name: String(args['name'] ?? ''),
				passphrase:
					args['passphrase'] == null
						? undefined
						: String(args['passphrase']),
				saePassphrase:
					args['saePassphrase'] == null
						? undefined
						: String(args['saePassphrase']),
				ssid: args['ssid'] == null ? undefined : String(args['ssid']),
				description:
					args['description'] == null
						? undefined
						: String(args['description']),
				enabled:
					typeof args['enabled'] === 'boolean'
						? args['enabled']
						: undefined,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Edited Access Networks Unleashed WLAN ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	const cloneWlanSchema = buildToolInputSchema({
		sourceName: z
			.string()
			.min(1)
			.describe('Existing WLAN/SSID service name to copy from.'),
		newName: z
			.string()
			.min(1)
			.describe('Service name for the new WLAN.'),
		newSsid: z
			.string()
			.min(1)
			.optional()
			.describe('Optional SSID for the new WLAN. Defaults to newName.'),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.cloneWlan,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_clone_wlan',
			title: 'Clone Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation duplicates an existing WLAN configuration under a new name and SSID. The clone inherits the source passphrase unless edited afterwards.`,
			inputSchema: cloneWlanSchema.inputSchema,
			sdkInputSchema: cloneWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.cloneWlan({
				sourceName: String(args['sourceName'] ?? ''),
				newName: String(args['newName'] ?? ''),
				newSsid:
					args['newSsid'] == null ? undefined : String(args['newSsid']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Cloned Access Networks Unleashed WLAN ${String(args['sourceName'] ?? '')} to ${String(args['newName'] ?? '')}.`,
				result,
			)
		},
	)

	const deleteWlanSchema = wlanMutationSchema(
		accessNetworksUnleashed.writeAcknowledgements.deleteWlan,
	)
	registerTool(
		{
			name: 'access_networks_unleashed_delete_wlan',
			title: 'Delete Access Networks Unleashed WLAN',
			description: `${unleashedWriteDangerNotice} This typed operation permanently deletes a WLAN/SSID by name. Every client on that SSID will be disconnected, and the WLAN cannot be recovered without re-creating it.`,
			inputSchema: deleteWlanSchema.inputSchema,
			sdkInputSchema: deleteWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.deleteWlan({
				name: String(args['name'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Deleted Access Networks Unleashed WLAN ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	const addWlanGroupSchema = buildToolInputSchema({
		name: z.string().min(1).describe('Name for the new WLAN group.'),
		description: z
			.string()
			.optional()
			.describe('Optional human-readable description.'),
		wlans: z
			.array(z.string().min(1))
			.optional()
			.describe(
				'Optional list of existing WLAN service names to include in the group.',
			),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.addWlanGroup,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_add_wlan_group',
			title: 'Add Access Networks Unleashed WLAN Group',
			description: `${unleashedWriteDangerNotice} This typed operation creates a new WLAN group on the controller and optionally assigns existing WLANs to it.`,
			inputSchema: addWlanGroupSchema.inputSchema,
			sdkInputSchema: addWlanGroupSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const wlansArg = args['wlans']
			const wlans = Array.isArray(wlansArg)
				? wlansArg.map((value) => String(value))
				: undefined
			const result = await accessNetworksUnleashed.addWlanGroup({
				name: String(args['name'] ?? ''),
				description:
					args['description'] == null
						? undefined
						: String(args['description']),
				wlans,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Added Access Networks Unleashed WLAN group ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)

	const cloneWlanGroupSchema = buildToolInputSchema({
		sourceName: z
			.string()
			.min(1)
			.describe('Existing WLAN group to clone from.'),
		newName: z
			.string()
			.min(1)
			.describe('Name for the new WLAN group.'),
		description: z
			.string()
			.optional()
			.describe(
				'Optional new description. Defaults to the source description.',
			),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.cloneWlanGroup,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_clone_wlan_group',
			title: 'Clone Access Networks Unleashed WLAN Group',
			description: `${unleashedWriteDangerNotice} This typed operation duplicates an existing WLAN group with the same WLAN membership.`,
			inputSchema: cloneWlanGroupSchema.inputSchema,
			sdkInputSchema: cloneWlanGroupSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.cloneWlanGroup({
				sourceName: String(args['sourceName'] ?? ''),
				newName: String(args['newName'] ?? ''),
				description:
					args['description'] == null
						? undefined
						: String(args['description']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Cloned Access Networks Unleashed WLAN group ${String(args['sourceName'] ?? '')} to ${String(args['newName'] ?? '')}.`,
				result,
			)
		},
	)

	const deleteWlanGroupSchema = buildToolInputSchema({
		name: z
			.string()
			.min(1)
			.describe('Name of the WLAN group to delete.'),
		...createUnleashedWriteSchema(
			accessNetworksUnleashed.writeAcknowledgements.deleteWlanGroup,
		),
	})
	registerTool(
		{
			name: 'access_networks_unleashed_delete_wlan_group',
			title: 'Delete Access Networks Unleashed WLAN Group',
			description: `${unleashedWriteDangerNotice} This typed operation permanently deletes a WLAN group by name. Existing WLAN definitions are not removed, but APs that referenced this group will revert to the default group.`,
			inputSchema: deleteWlanGroupSchema.inputSchema,
			sdkInputSchema: deleteWlanGroupSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.deleteWlanGroup({
				name: String(args['name'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Deleted Access Networks Unleashed WLAN group ${String(args['name'] ?? '')}.`,
				result,
			)
		},
	)
}
