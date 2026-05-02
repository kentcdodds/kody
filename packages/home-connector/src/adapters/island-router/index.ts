import { type HomeConnectorConfig } from '../../config.ts'
import {
	type IslandRouterCommandResult,
	type IslandRouterCommandRunner,
	type IslandRouterDhcpLease,
	type IslandRouterHostDiagnosis,
	type IslandRouterInterfaceSummary,
	type IslandRouterNeighborEntry,
	type IslandRouterStatus,
} from './types.ts'
import { createIslandRouterSshCommandRunner } from './ssh-client.ts'
import {
	findMatchingDhcpLease,
	findMatchingNeighbor,
	parseIslandRouterClock,
	parseIslandRouterDhcpReservations,
	parseIslandRouterInterfaceDetails,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterNeighbors,
	parseIslandRouterPingResult,
	parseIslandRouterRecentEvents,
	parseIslandRouterVersion,
} from './parsing.ts'
import {
	assertIslandRouterConfigured,
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
	if (result.exitCode !== 0) {
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

	const interfaceDetails =
		interfaceResult.exitCode === 0 && !interfaceResult.timedOut
			? parseIslandRouterInterfaceDetails(
					interfaceResult.stdout,
					interfaceResult.commandLines,
				)
			: null
	const ipInterfaceDetails =
		ipInterfaceResult.exitCode === 0 && !ipInterfaceResult.timedOut
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

function dedupeRecentEvents(messages: Array<ReturnType<typeof parseIslandRouterRecentEvents>>) {
	const seen = new Set<string>()
	const merged = messages.flat()
	return merged.filter((event) => {
		const key = `${event.timestamp ?? ''}|${event.message}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
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

	return {
		getConfigStatus,
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
			if (versionResult.exitCode === 0 && !versionResult.timedOut) {
				version = parseIslandRouterVersion(
					versionResult.stdout,
					versionResult.commandLines,
				)
			} else {
				errors.push('Failed to load Island router version information.')
			}

			let clock = null
			if (clockResult.exitCode === 0 && !clockResult.timedOut) {
				clock = parseIslandRouterClock(clockResult.stdout, clockResult.commandLines)
			} else {
				errors.push('Failed to load Island router clock information.')
			}

			const interfaces =
				interfaceResult.exitCode === 0 && !interfaceResult.timedOut
					? parseIslandRouterInterfaceSummaries(
							interfaceResult.stdout,
							interfaceResult.commandLines,
						)
					: []
			if (interfaces.length === 0) {
				errors.push('No Island router interface summary data was returned.')
			}

			const neighbors =
				neighborResult.exitCode === 0 && !neighborResult.timedOut
					? parseIslandRouterNeighbors(
							neighborResult.stdout,
							neighborResult.commandLines,
						)
					: []
			if (neighborResult.exitCode !== 0 || neighborResult.timedOut) {
				errors.push('Failed to load Island router neighbor cache.')
			}

			return {
				config: configStatus,
				connected:
					versionResult.exitCode === 0 &&
					!versionResult.timedOut &&
					clockResult.exitCode === 0 &&
					!clockResult.timedOut &&
					interfaceResult.exitCode === 0 &&
					!interfaceResult.timedOut &&
					neighborResult.exitCode === 0 &&
					!neighborResult.timedOut,
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
				throw new Error('router_ping_host requires an IP address or hostname, not a MAC address.')
			}

			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			const result = await runner({
				id: 'ping',
				host: host.value,
				timeoutMs,
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
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			const result = ensureSuccessfulCommand(
				await runner({
					id: 'show-ip-neighbors',
					timeoutMs,
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
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			const result = ensureSuccessfulCommand(
				await runner({
					id: 'show-ip-dhcp-reservations',
					timeoutMs,
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
			const query = request.host ? validateIslandRouterHost(request.host).value : ''
			const limit = normalizeLimit(request.limit, 50, 200)
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			const result = ensureSuccessfulCommand(
				await runner({
					id: 'show-log',
					query: query.length > 0 ? query : undefined,
					timeoutMs,
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

			const neighbors =
				neighborResult.exitCode === 0 && !neighborResult.timedOut
					? parseIslandRouterNeighbors(
							neighborResult.stdout,
							neighborResult.commandLines,
						)
					: []
			if (neighborResult.exitCode !== 0 || neighborResult.timedOut) {
				errors.push('Failed to read the Island router neighbor cache.')
			}
			const arpEntry = findMatchingNeighbor(neighbors, host)

			const leases =
				dhcpResult.exitCode === 0 && !dhcpResult.timedOut
					? parseIslandRouterDhcpReservations(
							dhcpResult.stdout,
							dhcpResult.commandLines,
						)
					: []
			if (dhcpResult.exitCode !== 0 || dhcpResult.timedOut) {
				errors.push('Failed to read Island router DHCP reservations.')
			}
			const dhcpLease = findMatchingDhcpLease(leases, host)

			const interfaceSummaries =
				interfaceResult.exitCode === 0 && !interfaceResult.timedOut
					? parseIslandRouterInterfaceSummaries(
							interfaceResult.stdout,
							interfaceResult.commandLines,
						)
					: []
			if (interfaceResult.exitCode !== 0 || interfaceResult.timedOut) {
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
				eventResult.exitCode === 0 && !eventResult.timedOut
					? parseIslandRouterRecentEvents(
							eventResult.stdout,
							eventResult.commandLines,
						)
					: [],
			]
			if (eventResult.exitCode !== 0 || eventResult.timedOut) {
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
				if (macEventResult.exitCode === 0 && !macEventResult.timedOut) {
					recentEventSets.push(
						parseIslandRouterRecentEvents(
							macEventResult.stdout,
							macEventResult.commandLines,
						),
					)
				}
			}
			const recentEvents = dedupeRecentEvents(recentEventSets).slice(0, logLimit)

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
	}
}
