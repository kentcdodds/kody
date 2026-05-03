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

function registerRouterReadTool(input: {
	registerTool: (
		descriptor: IslandRouterRegisteredToolDescriptor,
		handler: IslandRouterToolHandler,
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

	const readTimeoutSchema = buildToolInputSchema({
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_wan_config',
		title: 'Get Island Router WAN Config',
		description:
			'Read WAN interface configuration for all WAN ports, including ISP/provider labels, addressing, failover role, and priority.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getWanConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.wans.length === 0
						? 'No Island router WAN interfaces were parsed.'
						: `Loaded ${result.wans.length} Island router WAN interface configuration entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_failover_status',
		title: 'Get Island Router Failover Status',
		description:
			'Read multi-WAN failover status including the active ISP/interface, health state per WAN, and failover policy.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getFailoverStatus({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text: result.healthChecks.length === 0
					? 'No Island router failover health checks were parsed.'
					: `Loaded Island router failover status with ${result.healthChecks.length} WAN health check entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_routing_table',
		title: 'Get Island Router Routing Table',
		description: 'Read the Island router IP routing table.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getRoutingTable({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.routes.length === 0
						? 'No Island router routes were parsed.'
						: `Loaded ${result.routes.length} Island router route entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_nat_rules',
		title: 'Get Island Router NAT Rules',
		description:
			'Read Island router NAT and port-forwarding rules from the typed allowlisted CLI views.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getNatRules({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.rules.length === 0
						? 'No Island router NAT rules were parsed.'
						: `Loaded ${result.rules.length} Island router NAT rule(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_vlan_config',
		title: 'Get Island Router VLAN Config',
		description:
			'Read Island router VLAN definitions, interface assignments, and parsed addressing details when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getVlanConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.vlans.length === 0
						? 'No Island router VLAN configuration entries were parsed.'
						: `Loaded ${result.vlans.length} Island router VLAN configuration entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_dns_config',
		title: 'Get Island Router DNS Config',
		description:
			'Read Island router DNS server configuration and parsed local DNS override records when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getDnsConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text: `Loaded Island router DNS configuration with ${result.servers.length} server(s) and ${result.overrides.length} override(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_users',
		title: 'Get Island Router Users',
		description:
			'Read Island router local or connected user account information from the CLI user views.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getUsers({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.users.length === 0
						? 'No Island router users were parsed.'
						: `Loaded ${result.users.length} Island router user entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_security_policy',
		title: 'Get Island Router Security Policy',
		description:
			'Read Island router firewall, protection, or security-policy rules from the typed allowlisted CLI views.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getSecurityPolicy({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.rules.length === 0
						? 'No Island router security policy rules were parsed.'
						: `Loaded ${result.rules.length} Island router security policy rule(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_qos_config',
		title: 'Get Island Router QoS Config',
		description:
			'Read Island router QoS or traffic-shaping policy configuration from the typed allowlisted CLI views.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getQosConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.policies.length === 0
						? 'No Island router QoS policies were parsed.'
						: `Loaded ${result.policies.length} Island router QoS policy entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_traffic_stats',
		title: 'Get Island Router Traffic Stats',
		description:
			'Read per-interface Island router traffic statistics including bytes, packets, errors, and utilization when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getTrafficStats({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.interfaces.length === 0
						? 'No Island router traffic statistics were parsed.'
						: `Loaded traffic statistics for ${result.interfaces.length} Island router interface(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_active_sessions',
		title: 'Get Island Router Active Sessions',
		description:
			'Read the Island router active session or connection-state table, including parsed protocol and endpoint tuples.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getActiveSessions({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.sessions.length === 0
						? 'No Island router active sessions were parsed.'
						: `Loaded ${result.sessions.length} Island router active session(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_vpn_config',
		title: 'Get Island Router VPN Config',
		description:
			'Read Island router VPN or tunnel configuration (such as IPSec or GRE) from the typed allowlisted CLI views.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getVpnConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.tunnels.length === 0
						? 'No Island router VPN tunnels were parsed.'
						: `Loaded ${result.tunnels.length} Island router VPN or tunnel entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_dhcp_server_config',
		title: 'Get Island Router DHCP Server Config',
		description:
			'Read Island router DHCP server pools, options, and static reservation configuration.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getDhcpServerConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text: `Loaded Island router DHCP server config with ${result.pools.length} pool(s), ${result.options.length} option(s), and ${result.reservations.length} reservation(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_ntp_config',
		title: 'Get Island Router NTP Config',
		description:
			'Read Island router NTP or time-sync configuration including parsed upstream servers when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getNtpConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.servers.length === 0
						? 'No Island router NTP servers were parsed.'
						: `Loaded ${result.servers.length} Island router NTP server entry/entries.`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_syslog_config',
		title: 'Get Island Router Syslog Config',
		description:
			'Read Island router remote syslog target configuration when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getSyslogConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.targets.length === 0
						? 'No Island router syslog targets were parsed.'
						: `Loaded ${result.targets.length} Island router syslog target(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_snmp_config',
		title: 'Get Island Router SNMP Config',
		description:
			'Read Island router SNMP community and trap-target configuration when present.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getSnmpConfig({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text: `Loaded Island router SNMP config with ${result.communities.length} community entry/entries and ${result.trapTargets.length} trap target(s).`,
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_system_info',
		title: 'Get Island Router System Info',
		description:
			'Read Island router system-health information such as uptime, CPU usage, memory usage, and temperature when available.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getSystemInfo({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text: result.uptime
					? `Loaded Island router system info with uptime ${result.uptime}.`
					: 'Loaded Island router system info.',
				structuredContent: result,
			}
		},
	})

	registerRouterReadTool({
		registerTool,
		name: 'router_get_bandwidth_usage',
		title: 'Get Island Router Bandwidth Usage',
		description:
			'Read Island router real-time or historical bandwidth usage entries when the CLI exposes them.',
		inputSchema: readTimeoutSchema,
		handler: async (args) => {
			const result = await islandRouter.getBandwidthUsage({
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return {
				text:
					result.entries.length === 0
						? 'No Island router bandwidth usage entries were parsed.'
						: `Loaded ${result.entries.length} Island router bandwidth usage entry/entries.`,
				structuredContent: result,
			}
		},
	})

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

	const wanFailoverSchema = buildToolInputSchema({
		interfaceName: z
			.string()
			.min(1)
			.describe('WAN interface name to force into the active role.'),
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
			.literal(islandRouter.writeAcknowledgements.setWanFailover)
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

	registerTool(
		{
			name: 'router_set_wan_failover',
			title: 'Force Island Router WAN Failover',
			description: `${routerWriteDangerNotice} This typed allowlisted operation attempts to force WAN failover to a specific interface. The exact Island CLI command is a best-effort guess because public CLI docs only confirmed priority-based WAN selection, not an explicit manual failover command.`,
			inputSchema: wanFailoverSchema.inputSchema,
			sdkInputSchema: wanFailoverSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.setWanFailover({
				interfaceName: String(args['interfaceName'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Forced Island router WAN failover to ${String(args['interfaceName'] ?? '')}.`,
				result,
			)
		},
	)

	const allowlistedCliSchema = buildToolInputSchema({
		command: z
			.enum([
				'show-version',
				'show-clock',
				'show-interface-summary',
				'show-interface',
				'show-ip-interface',
			])
			.describe(
				'Allowlisted read-only Island router CLI command alias. No arbitrary CLI execution is allowed.',
			),
		interfaceName: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Required only for interface-scoped commands such as show-interface or show-ip-interface.',
			),
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
			.literal(islandRouter.writeAcknowledgements.runAllowlistedCliCommand)
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

	registerTool(
		{
			name: 'router_run_allowlisted_cli_command',
			title: 'Run Allowlisted Island Router CLI Command',
			description: `${routerWriteDangerNotice} This typed allowlisted escape hatch runs only a very small set of explicitly enumerated read-only show commands not already covered by a more specific tool. It never accepts arbitrary CLI text.`,
			inputSchema: allowlistedCliSchema.inputSchema,
			sdkInputSchema: allowlistedCliSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.runAllowlistedCliCommand({
				command: args['command'] as
					| 'show-version'
					| 'show-clock'
					| 'show-interface-summary'
					| 'show-interface'
					| 'show-ip-interface',
				interfaceName:
					args['interfaceName'] == null
						? undefined
						: String(args['interfaceName']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Ran allowlisted Island router CLI command ${result.command}.`,
				result,
			)
		},
	)

	const dhcpReservationSchema = buildToolInputSchema({
		action: z.enum(['set', 'remove']),
		macAddress: z.string().min(1).describe('Target MAC address for the reservation.'),
		ipAddress: z
			.string()
			.min(1)
			.optional()
			.describe('IPv4 address for set, or optional match hint for remove.'),
		hostName: z
			.string()
			.min(1)
			.optional()
			.describe('Optional hostname label for set operations.'),
		interfaceName: z
			.string()
			.min(1)
			.optional()
			.describe('Optional interface name for set operations.'),
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
			.literal(islandRouter.writeAcknowledgements.setDhcpReservation)
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

	registerTool(
		{
			name: 'router_set_dhcp_reservation',
			title: 'Change Island Router DHCP Reservation',
			description: `${routerWriteDangerNotice} This typed allowlisted operation adds, updates, or removes a static DHCP reservation by MAC address and IP. A mistake can strand devices on the wrong address or break expected host mappings.`,
			inputSchema: dhcpReservationSchema.inputSchema,
			sdkInputSchema: dhcpReservationSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const action = args['action'] === 'remove' ? 'remove' : 'set'
			const result = await islandRouter.setDhcpReservation({
				action,
				macAddress: String(args['macAddress'] ?? ''),
				ipAddress:
					args['ipAddress'] == null ? undefined : String(args['ipAddress']),
				hostName:
					args['hostName'] == null ? undefined : String(args['hostName']),
				interfaceName:
					args['interfaceName'] == null
						? undefined
						: String(args['interfaceName']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				action === 'remove'
					? 'Removed the requested Island router DHCP reservation.'
					: 'Set the requested Island router DHCP reservation.',
				result,
			)
		},
	)

	const rebootSchema = createRouterWriteSchema(
		islandRouter.writeAcknowledgements.reboot,
	)

	registerTool(
		{
			name: 'router_reboot',
			title: 'Reboot Island Router',
			description: `${routerWriteDangerNotice} This typed allowlisted operation reboots the live Island router. It can immediately disrupt all connectivity for the local network and should be used only with extreme certainty.`,
			inputSchema: rebootSchema.inputSchema,
			sdkInputSchema: rebootSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.rebootRouter({
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult('Issued an Island router reboot command.', result)
		},
	)

	const interfaceDescriptionSchema = buildToolInputSchema({
		interfaceName: z.string().min(1).describe('Interface name to relabel.'),
		description: z.string().min(1).describe('New interface description or label.'),
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
			.literal(islandRouter.writeAcknowledgements.setInterfaceDescription)
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

	registerTool(
		{
			name: 'router_set_interface_description',
			title: 'Set Island Router Interface Description',
			description: `${routerWriteDangerNotice} This typed allowlisted operation changes the description or label on a named interface.`,
			inputSchema: interfaceDescriptionSchema.inputSchema,
			sdkInputSchema: interfaceDescriptionSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.setInterfaceDescription({
				interfaceName: String(args['interfaceName'] ?? ''),
				description: String(args['description'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Updated Island router interface description for ${String(args['interfaceName'] ?? '')}.`,
				result,
			)
		},
	)

	const dnsServerWriteSchema = buildToolInputSchema({
		servers: z
			.array(z.string().min(1))
			.min(1)
			.describe('DNS server IP addresses or hostnames to configure.'),
		interfaceName: z
			.string()
			.min(1)
			.optional()
			.describe('Optional interface name when the DNS change should be scoped.'),
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
			.literal(islandRouter.writeAcknowledgements.setDnsServer)
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

	registerTool(
		{
			name: 'router_set_dns_server',
			title: 'Set Island Router DNS Server',
			description: `${routerWriteDangerNotice} This typed allowlisted operation changes the router DNS server configuration for a WAN or LAN context. A mistake can break name resolution across the network.`,
			inputSchema: dnsServerWriteSchema.inputSchema,
			sdkInputSchema: dnsServerWriteSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.setDnsServer({
				servers: Array.isArray(args['servers'])
					? args['servers'].map((value) => String(value))
					: [],
				interfaceName:
					args['interfaceName'] == null
						? undefined
						: String(args['interfaceName']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				'Updated Island router DNS server configuration.',
				result,
			)
		},
	)

	const hostMutationSchema = (
		confirmationPhrase: string,
		hostDescription: string,
	) =>
		buildToolInputSchema({
			host: z.string().min(1).describe(hostDescription),
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

	const blockHostSchema = hostMutationSchema(
		islandRouter.writeAcknowledgements.blockHost,
		'IPv4, IPv6, hostname, or MAC address to block.',
	)
	const unblockHostSchema = hostMutationSchema(
		islandRouter.writeAcknowledgements.unblockHost,
		'IPv4, IPv6, hostname, or MAC address to unblock.',
	)

	registerTool(
		{
			name: 'router_block_host',
			title: 'Block Host On Island Router',
			description: `${routerWriteDangerNotice} This typed allowlisted operation attempts to add a host-block rule for the specified IP or MAC address. A mistake can immediately cut off the wrong device from the network.`,
			inputSchema: blockHostSchema.inputSchema,
			sdkInputSchema: blockHostSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.blockHost({
				host: String(args['host'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Blocked host ${String(args['host'] ?? '')} on the Island router.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'router_unblock_host',
			title: 'Unblock Host On Island Router',
			description: `${routerWriteDangerNotice} This typed allowlisted operation attempts to remove a host-block rule for the specified IP or MAC address.`,
			inputSchema: unblockHostSchema.inputSchema,
			sdkInputSchema: unblockHostSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.unblockHost({
				host: String(args['host'] ?? ''),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Unblocked host ${String(args['host'] ?? '')} on the Island router.`,
				result,
			)
		},
	)
}
