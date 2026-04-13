import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createBondAdapter } from '../adapters/bond/index.ts'
import { type HomeConnectorConfig } from '../config.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type BondToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type BondRegisteredToolDescriptor = BondToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type BondToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

export function registerBondHomeConnectorTools(input: {
	registerTool: (
		descriptor: BondRegisteredToolDescriptor,
		handler: BondToolHandler,
	) => void
	bond: ReturnType<typeof createBondAdapter>
	config: HomeConnectorConfig
}) {
	const { registerTool, bond, config } = input

	function bondAuthenticationGuideText() {
		const port = String(config.port)
		return [
			'Bond local API authentication for the Kody home connector:',
			'',
			`1. Open the home connector admin UI in a browser on the host that runs this process (or tunnel to it). The HTTP server listens on port ${port} unless overridden by the PORT environment variable.`,
			'',
			'2. Use these paths on that server:',
			'   - /bond/status — run "Scan now" to discover Bond bridges on the LAN.',
			'   - /bond/setup — Bond token setup: paste a token from the Bond app, or use "Retrieve and save token" when the bridge allows GET /v2/token (often within ~10 minutes after power-cycling the bridge).',
			'',
			'3. On /bond/setup you can also adopt a discovered bridge (required for most shade and device control from this connector).',
			'',
			'4. Tokens are stored only in the connector SQLite database (HOME_CONNECTOR_DATA_PATH / HOME_CONNECTOR_DB_PATH). They are not configured through MCP tools.',
			'',
			'5. Official Bond local HTTP API reference: https://docs-local.appbond.com/',
		].join('\n')
	}

	function bridgeScopedSchema(shape: Record<string, z.ZodTypeAny> = {}) {
		return buildToolInputSchema({
			bridgeId: z.string().min(1).optional(),
			...shape,
		})
	}

	registerTool(
		{
			name: 'bond_authentication_guide',
			title: 'Bond Authentication Guide',
			description:
				'Read-only reminder of how Bond local API tokens are stored and where to configure them in the home connector admin UI.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const text = bondAuthenticationGuideText()
			return {
				content: [
					{
						type: 'text' as const,
						text,
					},
				],
				structuredContent: {
					adminPort: config.port,
					statusPath: '/bond/status',
					setupPath: '/bond/setup',
					bondLocalApiDocsUrl: 'https://docs-local.appbond.com/',
				},
			}
		},
	)

	registerTool(
		{
			name: 'bond_list_bridges',
			title: 'List Bond Bridges',
			description:
				'List Bond bridges known to the connector (discovered and/or adopted) and whether a token is stored.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = bond.getStatus()
			const lines = status.bridges.map(
				(b) =>
					`- ${b.instanceName} (${b.bridgeId}) host=${b.host}:${String(b.port)} adopted=${String(b.adopted)} token=${String(b.hasStoredToken)}`,
			)
			return {
				content: [
					{
						type: 'text' as const,
						text:
							status.bridges.length === 0
								? 'No Bond bridges are currently known.'
								: lines.join('\n'),
					},
				],
				structuredContent: status,
			}
		},
	)

	registerTool(
		{
			name: 'bond_scan_bridges',
			title: 'Scan Bond Bridges',
			description:
				'Scan the local network for Bond bridges using the configured discovery mechanism (mDNS _bond._tcp or JSON discovery URL). Stale non-adopted rows are not removed when a scan finds nothing; use bond_prune_discovered_bridges to clear them.',
			inputSchema: {},
		},
		async () => {
			const bridges = await bond.scan()
			return {
				content: [
					{
						type: 'text' as const,
						text:
							bridges.length === 0
								? 'No Bond bridges discovered.'
								: `Discovered ${bridges.length} Bond bridge(s).`,
					},
				],
				structuredContent: {
					bridges,
					diagnostics: bond.getStatus().diagnostics,
				},
			}
		},
	)

	registerTool(
		{
			name: 'bond_adopt_bridge',
			title: 'Adopt Bond Bridge',
			description:
				'Mark a discovered Bond bridge as adopted so it can be controlled and receive stored tokens.',
			...buildToolInputSchema({
				bridgeId: z.string().min(1),
			}),
		},
		async (args) => {
			const bridgeId = String(args['bridgeId'] ?? '')
			const bridge = bond.adoptBridge(bridgeId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Adopted Bond bridge ${bridge.instanceName} (${bridge.bridgeId}).`,
					},
				],
				structuredContent: bridge,
			}
		},
	)

	registerTool(
		{
			name: 'bond_release_bridge',
			title: 'Release Bond Bridge',
			description:
				'Remove a Bond bridge and its stored token from this connector database. Fails if the bridge id is unknown.',
			...buildToolInputSchema({
				bridgeId: z.string().min(1),
			}),
		},
		async (args) => {
			const bridgeId = String(args['bridgeId'] ?? '')
			bond.releaseBridge(bridgeId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Released Bond bridge ${bridgeId}.`,
					},
				],
				structuredContent: { bridgeId, released: true },
			}
		},
	)

	registerTool(
		{
			name: 'bond_prune_discovered_bridges',
			title: 'Prune Discovered Bond Bridges',
			description:
				'Delete all non-adopted Bond bridges from this connector database (and their token rows). Adopted bridges are kept.',
			inputSchema: {},
		},
		async () => {
			const bridges = bond.pruneDiscoveredBridges()
			return {
				content: [
					{
						type: 'text' as const,
						text: `Pruned discovered Bond bridges. ${String(bridges.length)} bridge(s) remain.`,
					},
				],
				structuredContent: { bridges },
			}
		},
	)

	registerTool(
		{
			name: 'bond_update_bridge_connection',
			title: 'Update Bond Bridge Connection',
			description:
				'Update the stored host (and optional port) used to reach a Bond bridge when mDNS names are unreliable.',
			...buildToolInputSchema({
				bridgeId: z.string().min(1),
				host: z.string().min(1),
				port: z.number().int().min(1).max(65535).optional(),
			}),
		},
		async (args) => {
			const bridgeId = String(args['bridgeId'] ?? '')
			const host = String(args['host'] ?? '')
			const port = args['port'] == null ? undefined : Number(args['port'])
			const bridge = bond.updateBridgeConnection(bridgeId, { host, port })
			return {
				content: [
					{
						type: 'text' as const,
						text: `Updated Bond bridge ${bridge.bridgeId} connection to ${bridge.host}:${String(bridge.port)}.`,
					},
				],
				structuredContent: bridge,
			}
		},
	)

	registerTool(
		{
			name: 'bond_get_bridge_version',
			title: 'Get Bond Bridge Version',
			description:
				'Read Bond /v2/sys/version (no token required) for firmware and model metadata.',
			...bridgeScopedSchema({}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const version = await bond.fetchBridgeVersion(bridgeId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Bond firmware: ${String(version['fw_ver'] ?? 'unknown')}.`,
					},
				],
				structuredContent: version,
			}
		},
	)

	registerTool(
		{
			name: 'bond_list_devices',
			title: 'List Bond Devices',
			description:
				'List devices on an adopted Bond bridge with names, types, and supported actions.',
			...bridgeScopedSchema({}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const devices = await bond.listDevices(bridgeId)
			return {
				content: [
					{
						type: 'text' as const,
						text:
							devices.length === 0
								? 'No Bond devices returned.'
								: `Listed ${devices.length} Bond device(s).`,
					},
				],
				structuredContent: { devices },
			}
		},
	)

	registerTool(
		{
			name: 'bond_get_device',
			title: 'Get Bond Device',
			description: 'Fetch full Bond device metadata JSON.',
			...bridgeScopedSchema({
				deviceId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const deviceId = String(args['deviceId'] ?? '')
			const device = await bond.getDevice(bridgeId, deviceId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Fetched Bond device ${deviceId}.`,
					},
				],
				structuredContent: device,
			}
		},
	)

	registerTool(
		{
			name: 'bond_get_device_state',
			title: 'Get Bond Device State',
			description: 'Read Bond device state (shade position, etc.).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const deviceId = String(args['deviceId'] ?? '')
			const state = await bond.getDeviceState(bridgeId, deviceId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Read Bond device state for ${deviceId}.`,
					},
				],
				structuredContent: state,
			}
		},
	)

	registerTool(
		{
			name: 'bond_shade_open',
			title: 'Open Bond Shade',
			description:
				'Send Bond Open action. Specify deviceId or deviceName (fuzzy match).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1).optional(),
				deviceName: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.shadeOpen({
				bridgeId,
				deviceId:
					args['deviceId'] == null ? undefined : String(args['deviceId']),
				deviceName:
					args['deviceName'] == null ? undefined : String(args['deviceName']),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Sent Bond Open action.',
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'bond_shade_close',
			title: 'Close Bond Shade',
			description:
				'Send Bond Close action. Specify deviceId or deviceName (fuzzy match).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1).optional(),
				deviceName: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.shadeClose({
				bridgeId,
				deviceId:
					args['deviceId'] == null ? undefined : String(args['deviceId']),
				deviceName:
					args['deviceName'] == null ? undefined : String(args['deviceName']),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Sent Bond Close action.',
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'bond_shade_stop',
			title: 'Stop Bond Shade',
			description:
				'Send Bond Stop action. Specify deviceId or deviceName (fuzzy match).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1).optional(),
				deviceName: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.shadeStop({
				bridgeId,
				deviceId:
					args['deviceId'] == null ? undefined : String(args['deviceId']),
				deviceName:
					args['deviceName'] == null ? undefined : String(args['deviceName']),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Sent Bond Stop action.',
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'bond_shade_set_position',
			title: 'Set Bond Shade Position',
			description:
				'Send Bond SetPosition with a 0-100 argument. Specify deviceId or deviceName (fuzzy match).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1).optional(),
				deviceName: z.string().min(1).optional(),
				position: z.number().min(0).max(100),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.shadeSetPosition({
				bridgeId,
				deviceId:
					args['deviceId'] == null ? undefined : String(args['deviceId']),
				deviceName:
					args['deviceName'] == null ? undefined : String(args['deviceName']),
				position: Number(args['position'] ?? 0),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Sent Bond SetPosition action.',
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'bond_invoke_device_action',
			title: 'Invoke Bond Device Action',
			description:
				'Invoke an arbitrary Bond device action when it exists on the device profile (validated server-side).',
			...bridgeScopedSchema({
				deviceId: z.string().min(1).optional(),
				deviceName: z.string().min(1).optional(),
				action: z.string().min(1),
				argument: z.union([z.number(), z.string(), z.boolean()]).optional(),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.invokeDeviceAction({
				bridgeId,
				deviceId:
					args['deviceId'] == null ? undefined : String(args['deviceId']),
				deviceName:
					args['deviceName'] == null ? undefined : String(args['deviceName']),
				action: String(args['action'] ?? ''),
				argument:
					args['argument'] === undefined
						? undefined
						: (args['argument'] as number | string | boolean),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: `Invoked Bond device action ${String(args['action'] ?? '')}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	registerTool(
		{
			name: 'bond_list_groups',
			title: 'List Bond Groups',
			description:
				'List Bond groups with member devices and supported actions.',
			...bridgeScopedSchema({}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const groups = await bond.listGroups(bridgeId)
			return {
				content: [
					{
						type: 'text' as const,
						text:
							groups.length === 0
								? 'No Bond groups returned.'
								: `Listed ${groups.length} Bond group(s).`,
					},
				],
				structuredContent: { groups },
			}
		},
	)

	registerTool(
		{
			name: 'bond_get_group',
			title: 'Get Bond Group',
			description: 'Fetch full Bond group metadata JSON.',
			...bridgeScopedSchema({
				groupId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const groupId = String(args['groupId'] ?? '')
			const group = await bond.getGroup(bridgeId, groupId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Fetched Bond group ${groupId}.`,
					},
				],
				structuredContent: group,
			}
		},
	)

	registerTool(
		{
			name: 'bond_get_group_state',
			title: 'Get Bond Group State',
			description: 'Read Bond group state JSON.',
			...bridgeScopedSchema({
				groupId: z.string().min(1),
			}),
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const groupId = String(args['groupId'] ?? '')
			const state = await bond.getGroupState(bridgeId, groupId)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Read Bond group state for ${groupId}.`,
					},
				],
				structuredContent: state,
			}
		},
	)

	registerTool(
		{
			name: 'bond_invoke_group_action',
			title: 'Invoke Bond Group Action',
			description:
				'Invoke a Bond group action when it exists on the group profile (validated server-side).',
			...bridgeScopedSchema({
				groupId: z.string().min(1),
				action: z.string().min(1),
				argument: z.union([z.number(), z.string(), z.boolean()]).optional(),
			}),
		},
		async (args) => {
			const bridgeId =
				args['bridgeId'] == null ? undefined : String(args['bridgeId'])
			const result = await bond.invokeGroupAction({
				bridgeId,
				groupId: String(args['groupId'] ?? ''),
				action: String(args['action'] ?? ''),
				argument:
					args['argument'] === undefined
						? undefined
						: (args['argument'] as number | string | boolean),
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: `Invoked Bond group action ${String(args['action'] ?? '')}.`,
					},
				],
				structuredContent: result,
			}
		},
	)
}
