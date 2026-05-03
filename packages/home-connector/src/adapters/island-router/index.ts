import { type HomeConnectorConfig } from '../../config.ts'
import {
	type IslandRouterActiveSessions,
	type IslandRouterAllowlistedCliCommand,
	type IslandRouterAllowlistedCliCommandResult,
	type IslandRouterBandwidthUsage,
	type IslandRouterCommandRequest,
	type IslandRouterCommandResult,
	type IslandRouterCommandRunner,
	type IslandRouterDhcpLease,
	type IslandRouterDhcpServerConfig,
	type IslandRouterDnsConfig,
	type IslandRouterFailoverStatus,
	type IslandRouterHostDiagnosis,
	type IslandRouterInterfaceDetails,
	type IslandRouterInterfaceSummary,
	type IslandRouterNatRules,
	type IslandRouterNeighborEntry,
	type IslandRouterNtpConfig,
	type IslandRouterQosConfig,
	type IslandRouterRoutingTable,
	type IslandRouterSecurityPolicy,
	type IslandRouterSnmpConfig,
	type IslandRouterStatus,
	type IslandRouterSyslogConfig,
	type IslandRouterSystemInfo,
	type IslandRouterTrafficStats,
	type IslandRouterUsers,
	type IslandRouterVlanConfig,
	type IslandRouterVpnConfig,
	type IslandRouterWanConfig,
	type IslandRouterWriteOperationId,
	type IslandRouterWriteOperationResult,
} from './types.ts'
import { createIslandRouterSshCommandRunner } from './ssh-client.ts'
import {
	didIslandRouterCommandSucceed,
	findMatchingDhcpLease,
	findMatchingNeighbor,
	parseIslandRouterActiveSessions,
	parseIslandRouterBandwidthUsage,
	parseIslandRouterClock,
	parseIslandRouterDhcpReservations,
	parseIslandRouterDhcpServerConfig,
	parseIslandRouterDnsConfig,
	parseIslandRouterFailoverStatus,
	parseIslandRouterInterfaceDetails,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterNatRules,
	parseIslandRouterNeighbors,
	parseIslandRouterNtpConfig,
	parseIslandRouterPingResult,
	parseIslandRouterQosConfig,
	parseIslandRouterRecentEvents,
	parseIslandRouterRoutingTable,
	parseIslandRouterSecurityPolicy,
	parseIslandRouterSnmpConfig,
	parseIslandRouterSyslogConfig,
	parseIslandRouterSystemInfo,
	parseIslandRouterTrafficStats,
	parseIslandRouterUsers,
	parseIslandRouterVersion,
	parseIslandRouterVlanConfig,
	parseIslandRouterVpnConfig,
	parseIslandRouterWanConfig,
} from './parsing.ts'
import {
	assertIslandRouterConfigured,
	assertIslandRouterWriteConfigured,
	getIslandRouterConfigStatus,
	validateIslandRouterHost,
} from './validation.ts'

type PingRequest = {
	host: string
	timeoutMs?: number
}

type HostLookupRequest = {
	host: string
	timeoutMs?: number
}

type RecentEventRequest = {
	host?: string
	limit?: number
	timeoutMs?: number
}

type DiagnoseHostRequest = {
	host: string
	timeoutMs?: number
	logLimit?: number
}

type ReadRequest = {
	timeoutMs?: number
}

type WriteOperationRequest = {
	timeoutMs?: number
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
}

type SetWanFailoverRequest = WriteOperationRequest & {
	interfaceName: string
}

type RunAllowlistedCliCommandRequest = WriteOperationRequest & {
	command: IslandRouterAllowlistedCliCommand
	interfaceName?: string
}

type SetDhcpReservationRequest = WriteOperationRequest & {
	action: 'set' | 'remove'
	macAddress: string
	ipAddress?: string
	hostName?: string
	interfaceName?: string
}

type SetInterfaceDescriptionRequest = WriteOperationRequest & {
	interfaceName: string
	description: string
}

type SetDnsServerRequest = WriteOperationRequest & {
	servers: Array<string>
	interfaceName?: string
}

type HostWriteRequest = WriteOperationRequest & {
	host: string
}

const islandRouterWriteAcknowledgements = {
	setWanFailover:
		'I am highly certain forcing Island router WAN failover to a specific interface is necessary right now.',
	runAllowlistedCliCommand:
		'I am highly certain running this allowlisted Island router CLI command is necessary right now.',
	setDhcpReservation:
		'I am highly certain changing Island router DHCP reservations is necessary right now.',
	reboot:
		'I am highly certain rebooting the Island router is necessary right now.',
	setInterfaceDescription:
		'I am highly certain changing an Island router interface description is necessary right now.',
	setDnsServer:
		'I am highly certain changing Island router DNS server configuration is necessary right now.',
	blockHost:
		'I am highly certain blocking this host on the Island router is necessary right now.',
	unblockHost:
		'I am highly certain unblocking this host on the Island router is necessary right now.',
	renewDhcpClients:
		'I am highly certain renewing all Island router DHCP clients is necessary right now.',
	clearLogBuffer:
		'I am highly certain clearing the Island router log buffer is necessary right now.',
	saveRunningConfig:
		'I am highly certain saving the Island router running configuration is necessary right now.',
} as const

function normalizeLimit(value: number | undefined, fallback: number, max: number) {
	if (value == null || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.min(max, Math.trunc(value)))
}

function normalizeTimeoutMs(config: HomeConnectorConfig, timeoutMs?: number) {
	if (timeoutMs == null || !Number.isFinite(timeoutMs)) {
		return config.islandRouterCommandTimeoutMs
	}
	return Math.max(1000, Math.trunc(timeoutMs))
}

function assertNonEmpty(value: string, field: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new Error(`${field} must not be empty.`)
	}
	return trimmed
}

function normalizeInterfaceName(value: string) {
	return assertNonEmpty(value, 'interfaceName')
}

function normalizeIpv4Address(value: string, field: string) {
	const host = validateIslandRouterHost(value)
	if (host.kind !== 'ipv4') {
		throw new Error(`${field} must be a valid IPv4 address.`)
	}
	return host.value
}

function normalizeMacAddress(value: string) {
	const host = validateIslandRouterHost(value)
	if (host.kind !== 'mac') {
		throw new Error('macAddress must be a valid MAC address.')
	}
	return host.normalizedValue
}

function normalizeDnsServers(servers: Array<string>) {
	const normalized = servers
		.map((server) => assertNonEmpty(server, 'servers'))
		.map((server) => {
			const host = validateIslandRouterHost(server)
			if (host.kind === 'mac') {
				throw new Error('DNS servers must be IP addresses or hostnames, not MAC addresses.')
			}
			return host.value
		})
	if (normalized.length === 0) {
		throw new Error('servers must include at least one DNS server.')
	}
	return normalized
}

function ensureSuccessfulCommand(
	result: IslandRouterCommandResult,
	message: string,
) {
	if (result.timedOut) {
		throw new Error(`${message} timed out after ${result.durationMs}ms.`)
	}
	if (result.exitCode === null) {
		const reason = result.signal
			? `signal ${result.signal}`
			: 'an unknown termination state'
		throw new Error(
			`${message} failed because the command exited via ${reason}. ${result.stderr.trim()}`.trim(),
		)
	}
	if (!didIslandRouterCommandSucceed(result)) {
		throw new Error(
			`${message} failed with exit code ${result.exitCode}. ${result.stderr.trim()}`.trim(),
		)
	}
	return result
}

function getPrimaryInterfaceDetails(
	interfaceName: string | null,
	interfaceSummaries: Array<IslandRouterInterfaceSummary>,
) {
	if (!interfaceName) return null
	return (
		interfaceSummaries.find((summary) => summary.name === interfaceName) ?? null
	)
}

async function maybeGetInterfaceDetails(input: {
	runner: IslandRouterCommandRunner
	interfaceName: string | null
	timeoutMs: number
}) {
	if (!input.interfaceName) {
		return {
			interfaceDetails: null,
			ipInterfaceDetails: null,
		}
	}

	const [interfaceResult, ipInterfaceResult] = await Promise.all([
		input.runner({
			id: 'show-interface',
			interfaceName: input.interfaceName,
			timeoutMs: input.timeoutMs,
		}),
		input.runner({
			id: 'show-ip-interface',
			interfaceName: input.interfaceName,
			timeoutMs: input.timeoutMs,
		}),
	])

	const interfaceDetails = didIslandRouterCommandSucceed(interfaceResult)
		? parseIslandRouterInterfaceDetails(
				interfaceResult.stdout,
				interfaceResult.commandLines,
			)
		: null
	const ipInterfaceDetails = didIslandRouterCommandSucceed(ipInterfaceResult)
		? parseIslandRouterInterfaceDetails(
				ipInterfaceResult.stdout,
				ipInterfaceResult.commandLines,
			)
		: null

	return {
		interfaceDetails,
		ipInterfaceDetails,
	}
}

function getPreferredInterfaceName(input: {
	neighbor: IslandRouterNeighborEntry | null
	dhcpLease: IslandRouterDhcpLease | null
}) {
	return input.neighbor?.interfaceName ?? input.dhcpLease?.interfaceName ?? null
}

function dedupeRecentEvents(
	messages: Array<ReturnType<typeof parseIslandRouterRecentEvents>>,
) {
	const seen = new Set<string>()
	const merged = messages.flat()
	return merged.filter((event) => {
		const key = `${event.timestamp ?? ''}|${event.message}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function assertWriteAcknowledgement(
	received: string,
	expected: string,
	operationLabel: string,
) {
	if (received.trim() !== expected) {
		throw new Error(
			`${operationLabel} requires the exact acknowledgement: "${expected}"`,
		)
	}
}

function assertWriteReason(reason: string, operationLabel: string) {
	const trimmed = reason.trim()
	if (trimmed.length < 20) {
		throw new Error(
			`${operationLabel} requires a specific operator reason of at least 20 characters.`,
		)
	}
}

function combineSuccessfulCommandOutputs(
	results: Array<IslandRouterCommandResult>,
) {
	const successful = results.filter((result) => didIslandRouterCommandSucceed(result))
	return {
		successful,
		stdout: successful.map((result) => result.stdout).join('\n'),
		commandLines: successful.flatMap((result) => result.commandLines),
	}
}

async function runHighRiskCommand(input: {
	config: HomeConnectorConfig
	runner: IslandRouterCommandRunner
	timeoutMs?: number
	operationId: IslandRouterWriteOperationId
	commandRequest: IslandRouterCommandRequest
	message: string
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
	expectedAcknowledgement: string
}) {
	assertIslandRouterWriteConfigured(input.config)
	if (!input.acknowledgeHighRisk) {
		throw new Error(
			`${input.message} requires acknowledgeHighRisk=true because this is a high-risk mutating router operation.`,
		)
	}
	assertWriteReason(input.reason, input.message)
	assertWriteAcknowledgement(
		input.confirmation,
		input.expectedAcknowledgement,
		input.message,
	)
	const timeoutMs = normalizeTimeoutMs(input.config, input.timeoutMs)
	const commandRequest = {
		...input.commandRequest,
		timeoutMs,
	} as IslandRouterCommandRequest
	const result = ensureSuccessfulCommand(
		await input.runner(commandRequest),
		input.message,
	)
	return {
		operationId: input.operationId,
		commandId:
			result.id as IslandRouterWriteOperationResult['commandId'],
		commandLines: result.commandLines,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
	} satisfies IslandRouterWriteOperationResult
}

export function createIslandRouterAdapter(input: {
	config: HomeConnectorConfig
	commandRunner?: IslandRouterCommandRunner
}) {
	const { config } = input
	let cachedRunner: IslandRouterCommandRunner | null = null

	function getRunner() {
		if (input.commandRunner) return input.commandRunner
		cachedRunner ??= createIslandRouterSshCommandRunner(config)
		return cachedRunner
	}

	function getConfigStatus() {
		return getIslandRouterConfigStatus(config)
	}

	async function executeReadCommand<T>(
		request: IslandRouterCommandRequest,
		message: string,
		parser: (stdout: string, commandLines: Array<string>) => T,
	) {
		assertIslandRouterConfigured(config)
		const result = ensureSuccessfulCommand(
			await getRunner()({
				...request,
				timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
			} as IslandRouterCommandRequest),
			message,
		)
		return parser(result.stdout, result.commandLines)
	}

	async function executeCompoundReadCommand<T>(input: {
		requests: Array<IslandRouterCommandRequest>
		message: string
		parser: (stdout: string, commandLines: Array<string>) => T
	}) {
		assertIslandRouterConfigured(config)
		const results = await Promise.all(
			input.requests.map((request) =>
				getRunner()({
					...request,
					timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
				} as IslandRouterCommandRequest),
			),
		)
		const combined = combineSuccessfulCommandOutputs(results)
		if (combined.successful.length === 0) {
			throw ensureSuccessfulCommand(results[0]!, input.message)
		}
		return input.parser(combined.stdout, combined.commandLines)
	}

	return {
		getConfigStatus,
		writeAcknowledgements: islandRouterWriteAcknowledgements,
		async getStatus(): Promise<IslandRouterStatus> {
			const configStatus = getConfigStatus()
			if (!configStatus.configured) {
				const missingReasons = [
					...configStatus.missingFields,
					...configStatus.warnings,
				].filter(Boolean)
				return {
					config: configStatus,
					connected: false,
					router: {
						version: null,
						clock: null,
					},
					interfaces: [],
					neighbors: [],
					errors: [
						`Island router diagnostics are not configured: ${missingReasons.join(', ')}.`,
					],
				}
			}

			assertIslandRouterConfigured(config)
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config)
			const errors: Array<string> = []

			const [versionResult, clockResult, interfaceResult, neighborResult] =
				await Promise.all([
					runner({
						id: 'show-version',
						timeoutMs,
					}),
					runner({
						id: 'show-clock',
						timeoutMs,
					}),
					runner({
						id: 'show-interface-summary',
						timeoutMs,
					}),
					runner({
						id: 'show-ip-neighbors',
						timeoutMs,
					}),
				])

			let version = null
			if (didIslandRouterCommandSucceed(versionResult)) {
				version = parseIslandRouterVersion(
					versionResult.stdout,
					versionResult.commandLines,
				)
			} else {
				errors.push('Failed to load Island router version information.')
			}

			let clock = null
			if (didIslandRouterCommandSucceed(clockResult)) {
				clock = parseIslandRouterClock(
					clockResult.stdout,
					clockResult.commandLines,
				)
			} else {
				errors.push('Failed to load Island router clock information.')
			}

			const interfaces = didIslandRouterCommandSucceed(interfaceResult)
				? parseIslandRouterInterfaceSummaries(
						interfaceResult.stdout,
						interfaceResult.commandLines,
					)
				: []
			if (interfaces.length === 0) {
				errors.push('No Island router interface summary data was returned.')
			}

			const neighbors = didIslandRouterCommandSucceed(neighborResult)
				? parseIslandRouterNeighbors(
						neighborResult.stdout,
						neighborResult.commandLines,
					)
				: []
			if (!didIslandRouterCommandSucceed(neighborResult)) {
				errors.push('Failed to load Island router neighbor cache.')
			}

			return {
				config: configStatus,
				connected:
					didIslandRouterCommandSucceed(versionResult) &&
					didIslandRouterCommandSucceed(clockResult) &&
					didIslandRouterCommandSucceed(interfaceResult) &&
					didIslandRouterCommandSucceed(neighborResult),
				router: {
					version,
					clock,
				},
				interfaces,
				neighbors,
				errors,
			}
		},
		async pingHost(request: PingRequest) {
			assertIslandRouterConfigured(config)
			const host = validateIslandRouterHost(request.host)
			if (host.kind === 'mac') {
				throw new Error(
					'router_ping_host requires an IP address or hostname, not a MAC address.',
				)
			}

			const result = await getRunner()({
				id: 'ping',
				host: host.value,
				timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
				allowTimeout: true,
			})
			return parseIslandRouterPingResult({
				host,
				stdout: result.stdout,
				stderr: result.stderr,
				commandLines: result.commandLines,
				timedOut: result.timedOut,
			})
		},
		async getArpEntry(request: HostLookupRequest) {
			assertIslandRouterConfigured(config)
			const identity = validateIslandRouterHost(request.host)
			const result = ensureSuccessfulCommand(
				await getRunner()({
					id: 'show-ip-neighbors',
					timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
				}),
				'Island router neighbor lookup',
			)
			const entries = parseIslandRouterNeighbors(
				result.stdout,
				result.commandLines,
			)
			return {
				host: identity,
				entry: findMatchingNeighbor(entries, identity),
				entries,
			}
		},
		async getDhcpLease(request: HostLookupRequest) {
			assertIslandRouterConfigured(config)
			const identity = validateIslandRouterHost(request.host)
			const result = ensureSuccessfulCommand(
				await getRunner()({
					id: 'show-ip-dhcp-reservations',
					timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
				}),
				'Island router DHCP reservation lookup',
			)
			const leases = parseIslandRouterDhcpReservations(
				result.stdout,
				result.commandLines,
			)
			return {
				host: identity,
				lease: findMatchingDhcpLease(leases, identity),
				leases,
			}
		},
		async getRecentEvents(request: RecentEventRequest = {}) {
			assertIslandRouterConfigured(config)
			const query = request.host
				? validateIslandRouterHost(request.host).value
				: ''
			const limit = normalizeLimit(request.limit, 50, 200)
			const result = ensureSuccessfulCommand(
				await getRunner()({
					id: 'show-log',
					query: query.length > 0 ? query : undefined,
					timeoutMs: normalizeTimeoutMs(config, request.timeoutMs),
				}),
				'Island router recent event lookup',
			)
			return parseIslandRouterRecentEvents(
				result.stdout,
				result.commandLines,
			).slice(0, limit)
		},
		async diagnoseHost(
			request: DiagnoseHostRequest,
		): Promise<IslandRouterHostDiagnosis> {
			assertIslandRouterConfigured(config)
			const host = validateIslandRouterHost(request.host)
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			const logLimit = normalizeLimit(request.logLimit, 20, 100)
			const errors: Array<string> = []

			const pingPromise =
				host.kind === 'mac'
					? Promise.resolve(null)
					: runner({
							id: 'ping',
							host: host.value,
							timeoutMs,
							allowTimeout: true,
						}).then((result) =>
							parseIslandRouterPingResult({
								host,
								stdout: result.stdout,
								stderr: result.stderr,
								commandLines: result.commandLines,
								timedOut: result.timedOut,
							}),
						)

			const [ping, neighborResult, dhcpResult, interfaceResult, eventResult] =
				await Promise.all([
					pingPromise,
					runner({
						id: 'show-ip-neighbors',
						timeoutMs,
					}),
					runner({
						id: 'show-ip-dhcp-reservations',
						timeoutMs,
					}),
					runner({
						id: 'show-interface-summary',
						timeoutMs,
					}),
					runner({
						id: 'show-log',
						query: host.value,
						timeoutMs,
					}),
				])

			const neighbors = didIslandRouterCommandSucceed(neighborResult)
				? parseIslandRouterNeighbors(
						neighborResult.stdout,
						neighborResult.commandLines,
					)
				: []
			if (!didIslandRouterCommandSucceed(neighborResult)) {
				errors.push('Failed to read the Island router neighbor cache.')
			}
			const arpEntry = findMatchingNeighbor(neighbors, host)

			const leases = didIslandRouterCommandSucceed(dhcpResult)
				? parseIslandRouterDhcpReservations(
						dhcpResult.stdout,
						dhcpResult.commandLines,
					)
				: []
			if (!didIslandRouterCommandSucceed(dhcpResult)) {
				errors.push('Failed to read Island router DHCP reservations.')
			}
			const dhcpLease = findMatchingDhcpLease(leases, host)

			const interfaceSummaries = didIslandRouterCommandSucceed(interfaceResult)
				? parseIslandRouterInterfaceSummaries(
						interfaceResult.stdout,
						interfaceResult.commandLines,
					)
				: []
			if (!didIslandRouterCommandSucceed(interfaceResult)) {
				errors.push('Failed to read Island router interface summary.')
			}
			const preferredInterfaceName = getPreferredInterfaceName({
				neighbor: arpEntry,
				dhcpLease,
			})
			const interfaceSummary = getPrimaryInterfaceDetails(
				preferredInterfaceName,
				interfaceSummaries,
			)

			const recentEventSets = [
				didIslandRouterCommandSucceed(eventResult)
					? parseIslandRouterRecentEvents(
							eventResult.stdout,
							eventResult.commandLines,
						)
					: [],
			]
			if (!didIslandRouterCommandSucceed(eventResult)) {
				errors.push('Failed to read Island router recent events.')
			}

			if (
				arpEntry?.macAddress &&
				host.kind !== 'mac' &&
				arpEntry.macAddress !== host.normalizedValue
			) {
				const macEventResult = await runner({
					id: 'show-log',
					query: arpEntry.macAddress,
					timeoutMs,
				})
				if (didIslandRouterCommandSucceed(macEventResult)) {
					recentEventSets.push(
						parseIslandRouterRecentEvents(
							macEventResult.stdout,
							macEventResult.commandLines,
						),
					)
				}
			}

			const recentEvents = dedupeRecentEvents(recentEventSets).slice(
				0,
				logLimit,
			)
			const { interfaceDetails, ipInterfaceDetails } =
				await maybeGetInterfaceDetails({
					runner,
					interfaceName: preferredInterfaceName,
					timeoutMs,
				})

			if (!arpEntry) {
				errors.push(
					'No matching ARP/neighbor entry was found for the requested host.',
				)
			}
			if (!dhcpLease) {
				errors.push(
					'No matching DHCP reservation was found for the requested host.',
				)
			}

			return {
				host,
				ping,
				arpEntry,
				dhcpLease,
				interfaceSummary,
				interfaceDetails,
				ipInterfaceDetails,
				recentEvents,
				errors,
			}
		},
		async getWanConfig(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-wan',
					timeoutMs: request.timeoutMs,
				},
				'Island router WAN configuration lookup',
				parseIslandRouterWanConfig,
			)
		},
		async getFailoverStatus(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-wan-failover',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router failover status lookup',
				parser: parseIslandRouterFailoverStatus,
			})
		},
		async getRoutingTable(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-ip-routes',
					timeoutMs: request.timeoutMs,
				},
				'Island router routing table lookup',
				parseIslandRouterRoutingTable,
			)
		},
		async getNatRules(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-nat',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router NAT rule lookup',
				parser: parseIslandRouterNatRules,
			})
		},
		async getVlanConfig(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-vlan',
					timeoutMs: request.timeoutMs,
				},
				'Island router VLAN configuration lookup',
				parseIslandRouterVlanConfig,
			)
		},
		async getDnsConfig(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-dns',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router DNS configuration lookup',
				parser: parseIslandRouterDnsConfig,
			})
		},
		async getUsers(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-users',
						timeoutMs: request.timeoutMs,
					},
					{
						id: 'show-user',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router user lookup',
				parser: parseIslandRouterUsers,
			})
		},
		async getSecurityPolicy(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-security-policy',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router security policy lookup',
				parser: parseIslandRouterSecurityPolicy,
			})
		},
		async getQosConfig(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-qos',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router QoS configuration lookup',
				parser: parseIslandRouterQosConfig,
			})
		},
		async getTrafficStats(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-interface-statistics',
					timeoutMs: request.timeoutMs,
				},
				'Island router traffic statistics lookup',
				parseIslandRouterTrafficStats,
			)
		},
		async getActiveSessions(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-sessions',
					timeoutMs: request.timeoutMs,
				},
				'Island router active session lookup',
				parseIslandRouterActiveSessions,
			)
		},
		async getVpnConfig(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-vpn',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router VPN configuration lookup',
				parser: parseIslandRouterVpnConfig,
			})
		},
		async getDhcpServerConfig(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-dhcp-server',
						timeoutMs: request.timeoutMs,
					},
					{
						id: 'show-ip-dhcp-reservations',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router DHCP server lookup',
				parser: parseIslandRouterDhcpServerConfig,
			})
		},
		async getNtpConfig(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-ntp-status',
						timeoutMs: request.timeoutMs,
					},
					{
						id: 'show-ntp-associations',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router NTP configuration lookup',
				parser: parseIslandRouterNtpConfig,
			})
		},
		async getSyslogConfig(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-syslog',
					timeoutMs: request.timeoutMs,
				},
				'Island router syslog configuration lookup',
				parseIslandRouterSyslogConfig,
			)
		},
		async getSnmpConfig(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-snmp',
					timeoutMs: request.timeoutMs,
				},
				'Island router SNMP configuration lookup',
				parseIslandRouterSnmpConfig,
			)
		},
		async getSystemInfo(request: ReadRequest = {}) {
			return await executeCompoundReadCommand({
				requests: [
					{
						id: 'show-system',
						timeoutMs: request.timeoutMs,
					},
					{
						id: 'show-hardware',
						timeoutMs: request.timeoutMs,
					},
				],
				message: 'Island router system info lookup',
				parser: parseIslandRouterSystemInfo,
			})
		},
		async getBandwidthUsage(request: ReadRequest = {}) {
			return await executeReadCommand(
				{
					id: 'show-bandwidth-usage',
					timeoutMs: request.timeoutMs,
				},
				'Island router bandwidth usage lookup',
				parseIslandRouterBandwidthUsage,
			)
		},
		async setWanFailover(request: SetWanFailoverRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'set-wan-failover',
				commandRequest: {
					id: 'force-wan-failover',
					interfaceName: normalizeInterfaceName(request.interfaceName),
				},
				message: 'Island router WAN failover change',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.setWanFailover,
			})
		},
		async runAllowlistedCliCommand(request: RunAllowlistedCliCommandRequest) {
			let commandRequest: IslandRouterCommandRequest
			switch (request.command) {
				case 'show-version':
					commandRequest = { id: 'show-version' }
					break
				case 'show-clock':
					commandRequest = { id: 'show-clock' }
					break
				case 'show-interface-summary':
					commandRequest = { id: 'show-interface-summary' }
					break
				case 'show-interface':
					commandRequest = {
						id: 'show-interface',
						interfaceName: normalizeInterfaceName(
							assertNonEmpty(request.interfaceName ?? '', 'interfaceName'),
						),
					}
					break
				case 'show-ip-interface':
					commandRequest = {
						id: 'show-ip-interface',
						interfaceName: normalizeInterfaceName(
							assertNonEmpty(request.interfaceName ?? '', 'interfaceName'),
						),
					}
					break
				default: {
					const _exhaustive: never = request.command
					throw new Error(
						`Unhandled allowlisted CLI command: ${String(_exhaustive)}`,
					)
				}
			}

			const result = await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'run-allowlisted-cli-command',
				commandRequest,
				message: 'Island router allowlisted CLI command',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.runAllowlistedCliCommand,
			})

			let parsedResult: IslandRouterAllowlistedCliCommandResult['result']
			switch (request.command) {
				case 'show-version':
					parsedResult = parseIslandRouterVersion(
						result.stdout,
						result.commandLines,
					)
					break
				case 'show-clock':
					parsedResult = {
						clock: parseIslandRouterClock(result.stdout, result.commandLines),
					}
					break
				case 'show-interface-summary':
					parsedResult = {
						interfaces: parseIslandRouterInterfaceSummaries(
							result.stdout,
							result.commandLines,
						),
					}
					break
				case 'show-interface':
				case 'show-ip-interface':
					parsedResult = parseIslandRouterInterfaceDetails(
						result.stdout,
						result.commandLines,
					)
					break
				default: {
					const _exhaustive: never = request.command
					throw new Error(
						`Unhandled allowlisted CLI parser: ${String(_exhaustive)}`,
					)
				}
			}

			return {
				command: request.command,
				commandId:
					result.commandId as IslandRouterAllowlistedCliCommandResult['commandId'],
				commandLines: result.commandLines,
				result: parsedResult,
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				durationMs: result.durationMs,
			} satisfies IslandRouterAllowlistedCliCommandResult
		},
		async setDhcpReservation(request: SetDhcpReservationRequest) {
			const macAddress = normalizeMacAddress(request.macAddress)
			const commandRequest: IslandRouterCommandRequest =
				request.action === 'remove'
					? {
							id: 'remove-dhcp-reservation',
							macAddress,
							ipAddress:
								request.ipAddress == null
									? undefined
									: normalizeIpv4Address(request.ipAddress, 'ipAddress'),
						}
					: {
							id: 'set-dhcp-reservation',
							macAddress,
							ipAddress: normalizeIpv4Address(
								assertNonEmpty(request.ipAddress ?? '', 'ipAddress'),
								'ipAddress',
							),
							hostName:
								request.hostName == null
									? undefined
									: assertNonEmpty(request.hostName, 'hostName'),
							interfaceName:
								request.interfaceName == null
									? undefined
									: normalizeInterfaceName(request.interfaceName),
						}
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'set-dhcp-reservation',
				commandRequest,
				message: 'Island router DHCP reservation change',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.setDhcpReservation,
			})
		},
		async rebootRouter(request: WriteOperationRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'reboot',
				commandRequest: {
					id: 'reboot',
				},
				message: 'Island router reboot',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement: islandRouterWriteAcknowledgements.reboot,
			})
		},
		async setInterfaceDescription(request: SetInterfaceDescriptionRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'set-interface-description',
				commandRequest: {
					id: 'set-interface-description',
					interfaceName: normalizeInterfaceName(request.interfaceName),
					description: assertNonEmpty(request.description, 'description'),
				},
				message: 'Island router interface description change',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.setInterfaceDescription,
			})
		},
		async setDnsServer(request: SetDnsServerRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'set-dns-server',
				commandRequest: {
					id: 'set-dns-server',
					servers: normalizeDnsServers(request.servers),
					interfaceName:
						request.interfaceName == null
							? undefined
							: normalizeInterfaceName(request.interfaceName),
				},
				message: 'Island router DNS server change',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.setDnsServer,
			})
		},
		async blockHost(request: HostWriteRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'block-host',
				commandRequest: {
					id: 'block-host',
					host: validateIslandRouterHost(request.host).value,
				},
				message: 'Island router host block',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement: islandRouterWriteAcknowledgements.blockHost,
			})
		},
		async unblockHost(request: HostWriteRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'unblock-host',
				commandRequest: {
					id: 'unblock-host',
					host: validateIslandRouterHost(request.host).value,
				},
				message: 'Island router host unblock',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement: islandRouterWriteAcknowledgements.unblockHost,
			})
		},
		async renewDhcpClients(request: WriteOperationRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'renew-dhcp-clients',
				commandRequest: {
					id: 'clear-dhcp-client',
				},
				message: 'Island router DHCP client renewal',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.renewDhcpClients,
			})
		},
		async clearLogBuffer(request: WriteOperationRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'clear-log-buffer',
				commandRequest: {
					id: 'clear-log',
				},
				message: 'Island router log clear',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.clearLogBuffer,
			})
		},
		async saveRunningConfig(request: WriteOperationRequest) {
			return await runHighRiskCommand({
				config,
				runner: getRunner(),
				timeoutMs: request.timeoutMs,
				operationId: 'save-running-config',
				commandRequest: {
					id: 'write-memory',
				},
				message: 'Island router configuration save',
				acknowledgeHighRisk: request.acknowledgeHighRisk,
				reason: request.reason,
				confirmation: request.confirmation,
				expectedAcknowledgement:
					islandRouterWriteAcknowledgements.saveRunningConfig,
			})
		},
	}
}
