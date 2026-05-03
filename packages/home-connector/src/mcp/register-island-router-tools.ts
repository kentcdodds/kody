import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createIslandRouterAdapter } from '../adapters/island-router/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type IslandRouterToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type IslandRouterRegisteredToolDescriptor = IslandRouterToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type IslandRouterToolHandler = (
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

const routerWriteDangerNotice =
	'HIGH RISK: this mutates a live router. Use it only when you are highly certain it is necessary and correct because mistakes can disrupt connectivity, destroy diagnostics, or persist a bad state with severe consequences.'

export function registerIslandRouterHomeConnectorTools(input: {
	registerTool: (
		descriptor: IslandRouterRegisteredToolDescriptor,
		handler: IslandRouterToolHandler,
	) => void
	islandRouter: ReturnType<typeof createIslandRouterAdapter>
}) {
	const { registerTool, islandRouter } = input

	const hostSchema = buildToolInputSchema({
		host: z
			.string()
			.min(1)
			.describe('IPv4, IPv6, hostname, or MAC address to inspect.'),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerTool(
		{
			name: 'router_get_status',
			title: 'Get Island Router Status',
			description:
				'Read-only Island router status snapshot including configuration readiness, version, interface summaries, and the current IP neighbor cache.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = await islandRouter.getStatus()
			const interfaceCount = status.interfaces.length
			const neighborCount = status.neighbors.length
			return structuredTextResult(
				status.config.configured
					? `Island router status loaded with ${interfaceCount} interface(s) and ${neighborCount} neighbor entry/entries.`
					: `Island router diagnostics are not fully configured: ${status.config.missingFields.join(', ')}.`,
				status,
			)
		},
	)

	registerTool(
		{
			name: 'router_ping_host',
			title: 'Ping Host From Island Router',
			description:
				'Run a read-only router-side ping toward a LAN or remote host and return parsed reachability details.',
			inputSchema: hostSchema.inputSchema,
			sdkInputSchema: hostSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.pingHost({
				host: String(args['host'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			const summary =
				result.reachable === true
					? `Island router ping reached ${result.host}.`
					: result.reachable === false
						? `Island router ping did not receive replies from ${result.host}.`
						: `Island router ping for ${result.host} did not complete cleanly.`
			return structuredTextResult(summary, result)
		},
	)

	registerTool(
		{
			name: 'router_get_arp_entry',
			title: 'Get Island Router ARP Entry',
			description:
				'Look up a host in the Island router neighbor cache and return the matching ARP/IP-neighbor entry plus the full parsed cache.',
			inputSchema: hostSchema.inputSchema,
			sdkInputSchema: hostSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.getArpEntry({
				host: String(args['host'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				result.entry
					? `Found an Island router neighbor entry for ${result.host.value}.`
					: `No Island router neighbor entry matched ${result.host.value}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'router_get_dhcp_lease',
			title: 'Get Island Router DHCP Lease',
			description:
				'Look up a host in the Island router DHCP reservation/lease view and return the matching entry plus the full parsed list.',
			inputSchema: hostSchema.inputSchema,
			sdkInputSchema: hostSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.getDhcpLease({
				host: String(args['host'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				result.lease
					? `Found an Island router DHCP entry for ${result.host.value}.`
					: `No Island router DHCP entry matched ${result.host.value}.`,
				result,
			)
		},
	)

	const recentEventsSchema = buildToolInputSchema({
		host: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional IPv4, IPv6, hostname, or MAC address to filter recent events.',
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.describe('Maximum number of events to return.'),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerTool(
		{
			name: 'router_get_recent_events',
			title: 'Get Island Router Recent Events',
			description:
				'Read recent Island router log entries, optionally filtered by a host/IP/MAC query.',
			inputSchema: recentEventsSchema.inputSchema,
			sdkInputSchema: recentEventsSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const events = await islandRouter.getRecentEvents({
				host: args['host'] == null ? undefined : String(args['host']),
				limit: args['limit'] == null ? undefined : Number(args['limit']),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				events.length === 0
					? 'No matching recent Island router events were found.'
					: `Loaded ${events.length} Island router event(s).`,
				{ events },
			)
		},
	)

	const diagnoseHostSchema = buildToolInputSchema({
		host: z
			.string()
			.min(1)
			.describe('IPv4, IPv6, hostname, or MAC address to diagnose.'),
		logLimit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe('Maximum number of recent log entries to include.'),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerTool(
		{
			name: 'router_diagnose_host',
			title: 'Diagnose Host From Island Router',
			description:
				'Run a read-only router-side diagnosis for a host and return parsed ping, ARP/neighbor, DHCP, interface, and recent-event data.',
			inputSchema: diagnoseHostSchema.inputSchema,
			sdkInputSchema: diagnoseHostSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const diagnosis = await islandRouter.diagnoseHost({
				host: String(args['host'] ?? ''),
				logLimit:
					args['logLimit'] == null ? undefined : Number(args['logLimit']),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			const summaryParts = [
				`Diagnosis for ${diagnosis.host.value}.`,
				diagnosis.ping?.reachable === true
					? 'Router ping succeeded.'
					: diagnosis.ping?.reachable === false
						? 'Router ping did not receive replies.'
						: 'Router ping was unavailable or inconclusive.',
				diagnosis.arpEntry
					? `Neighbor entry found on ${diagnosis.arpEntry.interfaceName ?? 'unknown interface'}.`
					: 'No neighbor entry found.',
				diagnosis.dhcpLease
					? 'DHCP data was found.'
					: 'No DHCP data was found.',
			]
			return structuredTextResult(summaryParts.join(' '), diagnosis)
		},
	)

	const createRouterWriteSchema = (confirmationPhrase: string) =>
		buildToolInputSchema({
			acknowledgeHighRisk: z
				.literal(true)
				.describe(
					'Must be true. Set this only when you are highly certain the requested router mutation is necessary and correct.',
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
			timeoutMs: z
				.number()
				.int()
				.min(1000)
				.max(60_000)
				.optional()
				.describe('Optional command timeout in milliseconds.'),
		})

	const renewDhcpClientsSchema = createRouterWriteSchema(
		islandRouter.writeAcknowledgements.renewDhcpClients,
	)
	const clearLogBufferSchema = createRouterWriteSchema(
		islandRouter.writeAcknowledgements.clearLogBuffer,
	)
	const saveRunningConfigSchema = createRouterWriteSchema(
		islandRouter.writeAcknowledgements.saveRunningConfig,
	)

	registerTool(
		{
			name: 'router_renew_dhcp_clients',
			title: 'Renew DHCP Clients On Island Router',
			description: `${routerWriteDangerNotice} This typed allowlisted operation runs the documented Island CLI command \`clear dhcp-client\` to request immediate renewal of DHCP-learned addresses. Never use it as a guess or for broad troubleshooting.`,
			inputSchema: renewDhcpClientsSchema.inputSchema,
			sdkInputSchema: renewDhcpClientsSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.renewDhcpClients({
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				'Triggered an immediate renewal of DHCP-learned addresses on the Island router.',
				result,
			)
		},
	)

	registerTool(
		{
			name: 'router_clear_log_buffer',
			title: 'Clear Island Router Log Buffer',
			description: `${routerWriteDangerNotice} This typed allowlisted operation runs the documented Island CLI command \`clear log\` and permanently removes the in-memory system log buffer. Use it only when you are highly certain existing log data is no longer needed.`,
			inputSchema: clearLogBufferSchema.inputSchema,
			sdkInputSchema: clearLogBufferSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.clearLogBuffer({
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				'Cleared the Island router in-memory log buffer.',
				result,
			)
		},
	)

	registerTool(
		{
			name: 'router_save_running_config',
			title: 'Save Island Router Running Config',
			description: `${routerWriteDangerNotice} This typed allowlisted operation runs the documented Island CLI command \`write memory\` to persist the current running configuration to startup storage. A mistake can permanently preserve a bad router state, so the agent must be highly certain before using it.`,
			inputSchema: saveRunningConfigSchema.inputSchema,
			sdkInputSchema: saveRunningConfigSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.saveRunningConfig({
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				'Saved the Island router running configuration to startup storage.',
				result,
			)
		},
	)
}
