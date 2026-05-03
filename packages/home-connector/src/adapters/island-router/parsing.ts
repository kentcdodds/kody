import {
	type IslandRouterActiveSession,
	type IslandRouterActiveSessions,
	type IslandRouterBandwidthUsage,
	type IslandRouterBandwidthUsageEntry,
	type IslandRouterDhcpServerConfig,
	type IslandRouterDhcpServerOption,
	type IslandRouterDhcpServerPool,
	type IslandRouterDnsConfig,
	type IslandRouterDnsOverride,
	type IslandRouterDnsServer,
	type IslandRouterDhcpLease,
	type IslandRouterFailoverHealthCheck,
	type IslandRouterFailoverStatus,
	type IslandRouterHostIdentity,
	type IslandRouterInterfaceDetails,
	type IslandRouterInterfaceSummary,
	type IslandRouterNeighborEntry,
	type IslandRouterNtpConfig,
	type IslandRouterNtpServer,
	type IslandRouterNatRule,
	type IslandRouterNatRules,
	type IslandRouterPingReply,
	type IslandRouterPingResult,
	type IslandRouterRecentEvent,
	type IslandRouterRouteEntry,
	type IslandRouterRoutingTable,
	type IslandRouterSecurityPolicy,
	type IslandRouterSecurityPolicyRule,
	type IslandRouterSnmpCommunity,
	type IslandRouterSnmpConfig,
	type IslandRouterSnmpTrapTarget,
	type IslandRouterSyslogConfig,
	type IslandRouterSyslogTarget,
	type IslandRouterSystemInfo,
	type IslandRouterTrafficStat,
	type IslandRouterTrafficStats,
	type IslandRouterUserEntry,
	type IslandRouterUsers,
	type IslandRouterVersionInfo,
	type IslandRouterVlanConfig,
	type IslandRouterVlanConfigEntry,
	type IslandRouterVpnConfig,
	type IslandRouterVpnTunnel,
	type IslandRouterWanConfig,
	type IslandRouterWanConnectionType,
	type IslandRouterWanInterfaceConfig,
	type IslandRouterWanRole,
	type IslandRouterQosConfig,
	type IslandRouterQosPolicyEntry,
} from './types.ts'

type ParsedTableRow = {
	rawLine: string
	fields: Record<string, string>
}

type ParsedTable = {
	headers: Array<string>
	rows: Array<ParsedTableRow>
}

const interfaceNamePattern =
	/\b(?:en\d+(?:\.\d+)?|eth\d+(?:\.\d+)?|wan\d+|lan\d+|vlan\d+|bond\d+|br\d+)\b/i
const interfaceLinkStatePattern = /\b(?:up|down)\b/i
const neighborStatePattern =
	/\b(?:reachable|stale|delay|probe|permanent|failed|incomplete)\b/i
const timestampPattern =
	/^(?<timestamp>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<rest>.*)$/
const macAddressPattern = /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/
const ipv4Pattern = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
const pingReplyPattern =
	/\bicmp_seq=(?<sequence>\d+)\b.*?\btime=(?<timeMs>\d+(?:\.\d+)?)\s*ms\b/i
const pingSummaryPattern =
	/(?<transmitted>\d+)\s+packets transmitted,\s+(?<received>\d+)\s+packets received,\s+(?<packetLoss>\d+(?:\.\d+)?)%\s+packet loss/i
const islandRouterVersionBannerPattern =
	/^(?<model>.+?)\s+\((?<hardwareModel>[^)]+)\)\s+serial number\s+(?<serialNumber>\S+)\s+Version\s+(?<firmwareVersion>\S+)$/i
const islandRouterCliFailurePattern =
	/\b(?:invalid command|unknown command|unrecognized command|syntax error|permission denied|host key verification failed|connection refused|no route to host|network is unreachable|could not resolve hostname|command not found|not recognized as an internal or external command)\b/i
const islandRouterPromptSuffixPattern = '[>#\\]]'
const islandRouterPromptOnlyPattern = /^(?:[a-z0-9_.:@-]+[>#]|\[[^\]\r\n]+\])$/i
const ipv6Pattern = /\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}\b/
const cidrPattern = /\b(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}\/\d{1,3})\b/
const percentPattern = /(?<value>\d+(?:\.\d+)?)\s*%/
const numberPattern = /-?\d+(?:\.\d+)?/
const hostPortPattern =
	/(?<host>(?:\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}|[a-z0-9_.-]+))(?::(?<port>\d+))?/i
const rateTokenPattern = /\b\d+(?:\.\d+)?\s*(?:[kmgt]?bps|[kmgt]?b\/s)\b/i
const uptimePattern =
	/\b\d+\s+(?:day|days|hour|hours|minute|minutes|second|seconds)\b/i
const enabledPattern = /\b(?:enabled|on|up|true|yes|allow|active)\b/i
const disabledPattern = /\b(?:disabled|off|down|false|no|deny|inactive)\b/i

function normalizeHeaderKey(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
}

function normalizeWhitespace(value: string) {
	return value.replaceAll(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPromptEchoLine(line: string, command: string) {
	const trimmed = normalizeWhitespace(line)
	const normalizedCommand = normalizeWhitespace(command)
	if (!trimmed || !normalizedCommand) return false
	return new RegExp(
		`^[^\\r\\n]+${islandRouterPromptSuffixPattern}\\s*${escapeRegExp(normalizedCommand)}$`,
	).test(trimmed)
}

function isPromptOnlyLine(line: string) {
	const trimmed = normalizeWhitespace(line)
	if (!trimmed) return false
	return islandRouterPromptOnlyPattern.test(trimmed)
}

function splitSanitizedStdoutLines(stdout: string) {
	return stdout
		.replaceAll(/\u001b\[[0-9;]*m/g, '')
		.split(/\r?\n/)
		.map((line) => line.replace(/\r/g, ''))
}

export function sanitizeIslandRouterOutput(
	stdout: string,
	commandLines: Array<string>,
) {
	const normalizedCommands = commandLines
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean)
	const lines = splitSanitizedStdoutLines(stdout)
	const firstCommandEchoIndex = lines.findIndex((line) =>
		normalizedCommands.some((command) => isPromptEchoLine(line, command)),
	)
	const relevantOutput =
		firstCommandEchoIndex >= 0 ? lines.slice(firstCommandEchoIndex) : lines

	return relevantOutput.filter((line) => {
		const trimmed = normalizeWhitespace(line)
		if (!trimmed) return false
		if (trimmed.toLowerCase() === 'goodbye') return false
		if (trimmed === 'exit') return false
		if (isPromptOnlyLine(trimmed)) return false
		if (normalizedCommands.includes(trimmed)) return false
		if (isPromptEchoLine(trimmed, 'exit')) return false
		for (const command of normalizedCommands) {
			if (isPromptEchoLine(trimmed, command)) return false
		}
		return true
	})
}

export function isSuccessfulIslandRouterCliSession(input: {
	stdout: string
	stderr: string
	commandLines: Array<string>
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
}) {
	if (input.timedOut || input.signal != null || input.exitCode !== 1) {
		return false
	}
	if (normalizeWhitespace(input.stderr).length > 0) {
		return false
	}

	const transcriptLines = input.stdout
		.split(/\r?\n/)
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean)
	const actionableCommands = input.commandLines.filter(
		(command) => normalizeWhitespace(command) !== 'terminal length 0',
	)
	const sawCommandEcho = actionableCommands.some((command) =>
		transcriptLines.some((line) => isPromptEchoLine(line, command)),
	)
	const sawExitPrompt = transcriptLines.some((line) =>
		isPromptEchoLine(line, 'exit'),
	)
	const sawGoodbye = transcriptLines.some(
		(line) => line.toLowerCase() === 'goodbye',
	)
	const sanitizedOutput = sanitizeIslandRouterOutput(
		input.stdout,
		input.commandLines,
	)

	if (
		sanitizedOutput.some((line) => islandRouterCliFailurePattern.test(line))
	) {
		return false
	}

	return sawCommandEcho && sawExitPrompt && sawGoodbye
}

export function didIslandRouterCommandSucceed(input: {
	stdout: string
	stderr: string
	commandLines: Array<string>
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
}) {
	if (input.timedOut || input.signal != null) {
		return false
	}
	return (
		input.exitCode === 0 ||
		isSuccessfulIslandRouterCliSession({
			stdout: input.stdout,
			stderr: input.stderr,
			commandLines: input.commandLines,
			exitCode: input.exitCode,
			signal: input.signal,
			timedOut: input.timedOut,
		})
	)
}

function splitTableColumns(line: string) {
	return line
		.trim()
		.split(/\s{2,}/)
		.map((part) => part.trim())
		.filter(Boolean)
}

function parseTextTable(lines: Array<string>): Array<ParsedTableRow> {
	let headerIndex = -1
	let headers: Array<string> = []

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		const columns = splitTableColumns(line)
		if (columns.length < 2) continue
		const next = lines[index + 1] ?? ''
		if (/^-{3,}(?:\s+-{3,})*$/.test(next.trim())) {
			headerIndex = index
			headers = columns.map(normalizeHeaderKey)
			break
		}
	}

	if (headerIndex < 0 || headers.length < 2) return []

	const rows: Array<ParsedTableRow> = []
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		if (!line.trim()) continue
		if (/^-{3,}(?:\s+-{3,})*$/.test(line.trim())) continue
		const columns = splitTableColumns(line)
		if (columns.length < 2) continue
		if (
			columns.length === headers.length &&
			columns.every(
				(column, columnIndex) =>
					normalizeHeaderKey(column) === (headers[columnIndex] ?? ''),
			)
		) {
			continue
		}
		const fields = Object.fromEntries(
			headers.map((header, columnIndex) => [
				header,
				columns[columnIndex] ?? '',
			]),
		)
		rows.push({
			rawLine: line,
			fields,
		})
	}

	return rows
}

function parseKeyValueLines(lines: Array<string>) {
	return lines.flatMap((line) => {
		const match = /^(?<key>[^:]+):\s*(?<value>.+)$/.exec(line)
		if (!match?.groups) return []
		return [
			{
				key: match.groups['key']?.trim() ?? '',
				value: match.groups['value']?.trim() ?? '',
			},
		]
	})
}

function findField(
	fields: Record<string, string>,
	candidates: Array<string>,
): string | null {
	for (const candidate of candidates) {
		const direct = fields[candidate]
		if (direct) return direct
	}
	const entries = Object.entries(fields)
	for (const candidate of candidates) {
		const fuzzy = entries.find(([key]) => key.includes(candidate))
		if (fuzzy?.[1]) return fuzzy[1]
	}
	return null
}

function extractMacAddress(value: string) {
	return value.match(macAddressPattern)?.[0]?.toLowerCase() ?? null
}

function extractIpv4Address(value: string) {
	return value.match(ipv4Pattern)?.[0] ?? null
}

function extractInterfaceName(value: string) {
	return value.match(interfaceNamePattern)?.[0] ?? null
}

function extractNeighborState(value: string) {
	return value.match(neighborStatePattern)?.[0]?.toLowerCase() ?? null
}

function extractInterfaceLinkState(value: string) {
	return value.match(interfaceLinkStatePattern)?.[0]?.toLowerCase() ?? null
}

export function parseIslandRouterVersion(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterVersionInfo {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	let bannerMatch: RegExpExecArray | null = null
	for (const line of lines) {
		const match = islandRouterVersionBannerPattern.exec(
			normalizeWhitespace(line),
		)
		if (match?.groups) {
			bannerMatch = match
			break
		}
	}
	const fallbackAttributes =
		bannerMatch?.groups == null
			? []
			: [
					{
						key: 'Model',
						value: bannerMatch.groups['model']?.trim() ?? '',
					},
					{
						key: 'Hardware Model',
						value: bannerMatch.groups['hardwareModel']?.trim() ?? '',
					},
					{
						key: 'Serial Number',
						value: bannerMatch.groups['serialNumber']?.trim() ?? '',
					},
					{
						key: 'Firmware Version',
						value: bannerMatch.groups['firmwareVersion']?.trim() ?? '',
					},
				].filter((entry) => entry.value.length > 0)
	return {
		model:
			findField(fieldMap, ['model', 'hardware_model']) ??
			bannerMatch?.groups['model']?.trim() ??
			null,
		serialNumber:
			findField(fieldMap, ['serial_number', 'serial']) ??
			bannerMatch?.groups['serialNumber']?.trim() ??
			null,
		firmwareVersion:
			findField(fieldMap, [
				'firmware_version',
				'software_version',
				'version',
			]) ??
			bannerMatch?.groups['firmwareVersion']?.trim() ??
			null,
		attributes: attributes.length > 0 ? attributes : fallbackAttributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterClock(
	stdout: string,
	commandLines: Array<string>,
) {
	return sanitizeIslandRouterOutput(stdout, commandLines).join('\n') || null
}

export function parseIslandRouterInterfaceSummaries(
	stdout: string,
	commandLines: Array<string>,
): Array<IslandRouterInterfaceSummary> {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const table = parseTextTable(lines)
	if (table.length > 0) {
		return table.map((row) => ({
			name: findField(row.fields, ['interface', 'iface', 'name']),
			linkState: findField(row.fields, ['link', 'status', 'state']),
			speed: findField(row.fields, ['speed']),
			duplex: findField(row.fields, ['duplex']),
			description: findField(row.fields, ['description', 'desc']),
			rawLine: row.rawLine,
			fields: row.fields,
		}))
	}

	return lines.map((line) => {
		const normalized = normalizeWhitespace(line)
		const tokens = normalized.split(' ')
		return {
			name: extractInterfaceName(line) ?? tokens[0] ?? null,
			linkState: extractInterfaceLinkState(line) ?? null,
			speed:
				tokens.find((token) => /\b\d+(?:g|m|mbps|gbps)\b/i.test(token)) ?? null,
			duplex:
				tokens.find((token) => /^(?:full|half)$/i.test(token))?.toLowerCase() ??
				null,
			description: null,
			rawLine: line,
			fields: {},
		}
	})
}

export function parseIslandRouterInterfaceDetails(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterInterfaceDetails {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const firstLine = lines[0] ?? ''
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	return {
		interfaceName:
			findField(fieldMap, ['interface', 'name']) ??
			extractInterfaceName(firstLine) ??
			null,
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterNeighbors(
	stdout: string,
	commandLines: Array<string>,
): Array<IslandRouterNeighborEntry> {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const table = parseTextTable(lines)
	if (table.length > 0) {
		return table.map((row) => ({
			ipAddress: findField(row.fields, ['ip', 'address', 'ip_address']),
			macAddress:
				findField(row.fields, [
					'mac',
					'lladdr',
					'link_layer_address',
				])?.toLowerCase() ?? null,
			interfaceName: findField(row.fields, ['interface', 'iface', 'device']),
			state: findField(row.fields, ['state', 'status'])?.toLowerCase() ?? null,
			rawLine: row.rawLine,
			fields: row.fields,
		}))
	}

	return lines.flatMap((line) => {
		const ipAddress = extractIpv4Address(line)
		const macAddress = extractMacAddress(line)
		if (!ipAddress && !macAddress) return []
		return [
			{
				ipAddress,
				macAddress,
				interfaceName: extractInterfaceName(line),
				state: extractNeighborState(line),
				rawLine: line,
				fields: {},
			},
		]
	})
}

export function parseIslandRouterDhcpReservations(
	stdout: string,
	commandLines: Array<string>,
): Array<IslandRouterDhcpLease> {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const table = parseTextTable(lines)
	if (table.length > 0) {
		return table.map((row) => ({
			ipAddress: findField(row.fields, ['ip', 'address', 'ip_address']),
			macAddress:
				findField(row.fields, ['mac', 'hardware_address'])?.toLowerCase() ??
				null,
			hostName: findField(row.fields, ['host', 'hostname', 'name']),
			interfaceName: findField(row.fields, ['interface', 'iface']),
			leaseType: 'reservation',
			rawLine: row.rawLine,
			fields: row.fields,
		}))
	}

	return lines.flatMap((line) => {
		const ipAddress = extractIpv4Address(line)
		const macAddress = extractMacAddress(line)
		if (!ipAddress && !macAddress) return []
		const hostName = normalizeWhitespace(
			line
				.replace(ipAddress ?? '', '')
				.replace(macAddress ?? '', '')
				.replace(interfaceNamePattern, '')
				.trim(),
		)
		return [
			{
				ipAddress,
				macAddress,
				hostName: hostName || null,
				interfaceName: extractInterfaceName(line),
				leaseType: 'reservation',
				rawLine: line,
				fields: {},
			},
		]
	})
}

export function parseIslandRouterRecentEvents(
	stdout: string,
	commandLines: Array<string>,
): Array<IslandRouterRecentEvent> {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	return lines.map((line) => {
		const match = timestampPattern.exec(line)
		const rest = match?.groups?.['rest']?.trim() ?? line.trim()
		const levelMatch = rest.match(
			/\b(?:emerg|alert|crit|err|warning|notice|info|debug)\b/i,
		)
		const moduleMatch = rest.match(/\b[a-z][a-z0-9_-]+(?=:)/i)
		return {
			timestamp: match?.groups?.['timestamp']?.trim() ?? null,
			level: levelMatch?.[0]?.toLowerCase() ?? null,
			module: moduleMatch?.[0] ?? null,
			message: rest,
			rawLine: line,
		}
	})
}

function parsePingReplies(lines: Array<string>) {
	return lines.flatMap((line) => {
		const match = pingReplyPattern.exec(line)
		if (!match?.groups) return []
		const sequenceRaw = match.groups['sequence'] ?? ''
		const timeMsRaw = match.groups['timeMs'] ?? ''
		return [
			{
				sequence: Number.parseInt(sequenceRaw, 10),
				timeMs: Number.parseFloat(timeMsRaw),
				rawLine: line,
			} satisfies IslandRouterPingReply,
		]
	})
}

export function parseIslandRouterPingResult(input: {
	host: IslandRouterHostIdentity
	stdout: string
	stderr: string
	commandLines: Array<string>
	timedOut: boolean
}): IslandRouterPingResult {
	const lines = sanitizeIslandRouterOutput(input.stdout, input.commandLines)
	const replies = parsePingReplies(lines)
	const summaryLine =
		lines.find((line) => pingSummaryPattern.test(line)) ??
		input.stderr.split(/\r?\n/).find((line) => pingSummaryPattern.test(line)) ??
		''
	const summaryMatch = pingSummaryPattern.exec(summaryLine)
	const transmitted = summaryMatch?.groups?.['transmitted']
		? Number.parseInt(summaryMatch.groups['transmitted'], 10)
		: null
	const received = summaryMatch?.groups?.['received']
		? Number.parseInt(summaryMatch.groups['received'], 10)
		: null
	const packetLossPercent = summaryMatch?.groups?.['packetLoss']
		? Number.parseFloat(summaryMatch.groups['packetLoss'])
		: null
	const reachable =
		received == null ? (replies.length > 0 ? true : null) : received > 0

	let addressFamily: IslandRouterPingResult['addressFamily']
	switch (input.host.kind) {
		case 'ipv4':
			addressFamily = 'ip'
			break
		case 'ipv6':
			addressFamily = 'ipv6'
			break
		case 'hostname':
			addressFamily = 'auto'
			break
		case 'mac':
			addressFamily = 'auto'
			break
		default: {
			const _exhaustive: never = input.host.kind
			throw new Error(`Unhandled host kind: ${String(_exhaustive)}`)
		}
	}

	return {
		host: input.host.value,
		addressFamily,
		reachable,
		timedOut: input.timedOut,
		completed: summaryMatch != null || replies.length > 0,
		transmitted,
		received,
		packetLossPercent,
		replies,
		rawOutput: lines.join('\n'),
		stderr: input.stderr.trim(),
	}
}

export function findMatchingNeighbor(
	entries: Array<IslandRouterNeighborEntry>,
	host: IslandRouterHostIdentity,
) {
	return (
		entries.find((entry) => {
			switch (host.kind) {
				case 'ipv4':
				case 'ipv6':
					return entry.ipAddress === host.normalizedValue
				case 'mac':
					return entry.macAddress === host.normalizedValue
				case 'hostname':
					return entry.rawLine.toLowerCase().includes(host.normalizedValue)
				default: {
					const _exhaustive: never = host.kind
					throw new Error(`Unhandled host kind: ${String(_exhaustive)}`)
				}
			}
		}) ?? null
	)
}

export function findMatchingDhcpLease(
	entries: Array<IslandRouterDhcpLease>,
	host: IslandRouterHostIdentity,
) {
	return (
		entries.find((entry) => {
			switch (host.kind) {
				case 'ipv4':
				case 'ipv6':
					return entry.ipAddress === host.normalizedValue
				case 'mac':
					return entry.macAddress === host.normalizedValue
				case 'hostname':
					return entry.hostName?.toLowerCase() === host.normalizedValue
				default: {
					const _exhaustive: never = host.kind
					throw new Error(`Unhandled host kind: ${String(_exhaustive)}`)
				}
			}
		}) ?? null
	)
}

function extractIpv6Address(value: string) {
	return value.match(ipv6Pattern)?.[0]?.toLowerCase() ?? null
}

function extractIpAddress(value: string) {
	return extractIpv4Address(value) ?? extractIpv6Address(value)
}

function extractCidr(value: string) {
	return value.match(cidrPattern)?.[0] ?? null
}

function parseNumber(value: string | null | undefined) {
	if (!value) return null
	const normalized = value.replaceAll(',', '')
	const match = normalized.match(numberPattern)
	if (!match?.[0]) return null
	const parsed = Number.parseFloat(match[0])
	return Number.isFinite(parsed) ? parsed : null
}

function parseInteger(value: string | null | undefined) {
	const parsed = parseNumber(value)
	if (parsed == null) return null
	return Math.trunc(parsed)
}

function parsePercent(value: string | null | undefined) {
	if (!value) return null
	const match = percentPattern.exec(value)
	if (!match?.groups?.['value']) return null
	const parsed = Number.parseFloat(match.groups['value'])
	return Number.isFinite(parsed) ? parsed : null
}

function parseEnabledFlag(value: string | null | undefined) {
	if (!value) return null
	if (enabledPattern.test(value)) return true
	if (disabledPattern.test(value)) return false
	return null
}

function parseHostPort(value: string | null | undefined) {
	if (!value) {
		return {
			host: null,
			port: null,
		}
	}
	const match = hostPortPattern.exec(value)
	return {
		host: match?.groups?.['host']?.trim() ?? null,
		port: match?.groups?.['port']
			? Number.parseInt(match.groups['port'], 10)
			: null,
	}
}

function normalizeConnectionType(
	value: string | null | undefined,
): IslandRouterWanConnectionType {
	if (!value) return 'unknown'
	const normalized = value.toLowerCase()
	if (normalized.includes('pppoe')) return 'pppoe'
	if (normalized.includes('dhcp')) return 'dhcp'
	if (normalized.includes('static')) return 'static'
	return 'unknown'
}

function normalizeWanRole(value: string | null | undefined): IslandRouterWanRole {
	if (!value) return 'unknown'
	const normalized = value.toLowerCase()
	if (
		normalized.includes('active') ||
		normalized.includes('primary') ||
		normalized.includes('selected')
	) {
		return 'active'
	}
	if (
		normalized.includes('standby') ||
		normalized.includes('backup') ||
		normalized.includes('secondary')
	) {
		return 'standby'
	}
	return 'unknown'
}

function splitValueList(value: string | null | undefined) {
	if (!value) return []
	return value
		.split(/[,\s]+/)
		.map((part) => part.trim())
		.filter(Boolean)
}

function extractRate(value: string | null | undefined) {
	if (!value) return null
	return value.match(rateTokenPattern)?.[0] ?? null
}

function buildFieldMapFromAttributes(lines: Array<string>) {
	const attributes = parseKeyValueLines(lines)
	return Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
}

function selectRowsOrFallback(lines: Array<string>) {
	const rows = parseTextTable(lines)
	if (rows.length > 0) return rows
	return lines.map((line) => ({
		rawLine: line,
		fields: {},
	}))
}

export function parseIslandRouterWanConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterWanConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		wans: rows.flatMap((row) => {
			const interfaceName =
				findField(row.fields, ['interface', 'iface', 'port', 'device']) ??
				extractInterfaceName(row.rawLine)
			const ipAddress =
				findField(row.fields, ['ip', 'ip_address', 'address']) ??
				extractIpAddress(row.rawLine)
			const gateway = findField(row.fields, ['gateway', 'gw'])
			if (!interfaceName && !ipAddress && !/wan|isp/i.test(row.rawLine)) {
				return []
			}
			const roleValue =
				findField(row.fields, ['role', 'state', 'status']) ?? row.rawLine
			return [
				{
					ispName: findField(row.fields, ['isp', 'provider', 'name']),
					interfaceName,
					ipAddress,
					gateway,
					connectionType: normalizeConnectionType(
						findField(row.fields, ['type', 'mode']) ?? row.rawLine,
					),
					role: normalizeWanRole(roleValue),
					failoverPriority: parseInteger(
						findField(row.fields, ['priority', 'failover_priority']),
					),
					linkState:
						findField(row.fields, ['link', 'status', 'state']) ??
						extractInterfaceLinkState(row.rawLine),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterWanInterfaceConfig,
			]
		}),
	}
}

export function parseIslandRouterFailoverStatus(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterFailoverStatus {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const fieldMap = buildFieldMapFromAttributes(lines)
	const rows = selectRowsOrFallback(lines)
	const healthChecks = rows.flatMap((row) => {
		const interfaceName =
			findField(row.fields, ['interface', 'iface', 'port', 'device']) ??
			extractInterfaceName(row.rawLine)
		if (!interfaceName && !/wan|isp/i.test(row.rawLine)) return []
		return [
			{
				interfaceName,
				ispName: findField(row.fields, ['isp', 'provider', 'name']),
				state: findField(row.fields, ['health', 'state', 'status']),
				role: normalizeWanRole(
					findField(row.fields, ['role', 'selected', 'active']) ?? row.rawLine,
				),
				failoverPriority: parseInteger(
					findField(row.fields, ['priority', 'failover_priority']),
				),
				monitor: findField(row.fields, ['monitor', 'probe', 'health_check']),
				rawLine: row.rawLine,
				fields: row.fields,
			} satisfies IslandRouterFailoverHealthCheck,
		]
	})
	const activeRow =
		healthChecks.find((entry) => entry.role === 'active') ?? healthChecks[0] ?? null
	return {
		activeInterfaceName:
			findField(fieldMap, ['active_interface', 'active_wan']) ??
			activeRow?.interfaceName ??
			null,
		activeIspName:
			findField(fieldMap, ['active_isp', 'active_provider']) ??
			activeRow?.ispName ??
			null,
		policy: findField(fieldMap, ['policy', 'failover_policy']),
		healthChecks,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterRoutingTable(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterRoutingTable {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		routes: rows.flatMap((row) => {
			const destination =
				findField(row.fields, ['destination', 'network', 'prefix']) ??
				extractCidr(row.rawLine) ??
				(/\bdefault\b/i.test(row.rawLine) ? 'default' : null)
			const gateway =
				findField(row.fields, ['gateway', 'via', 'next_hop']) ??
				row.rawLine.match(/\bvia\s+([^\s,]+)/i)?.[1] ??
				null
			const interfaceName =
				findField(row.fields, ['interface', 'iface', 'device']) ??
				row.rawLine.match(/\bdev\s+([^\s,]+)/i)?.[1] ??
				extractInterfaceName(row.rawLine)
			if (!destination && !gateway && !interfaceName) return []
			return [
				{
					destination,
					gateway,
					interfaceName,
					protocol:
						findField(row.fields, ['protocol', 'proto', 'type']) ??
						row.rawLine.match(/^(static|kernel|connected|ospf|bgp|rip)\b/i)?.[1] ??
						null,
					metric: parseInteger(findField(row.fields, ['metric', 'cost'])),
					selected:
						parseEnabledFlag(findField(row.fields, ['selected', 'active'])) ??
						(row.rawLine.trim().startsWith('*') ? true : null),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterRouteEntry,
			]
		}),
	}
}

export function parseIslandRouterNatRules(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterNatRules {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		rules: rows.flatMap((row) => {
			const external = parseHostPort(
				findField(row.fields, ['external', 'outside', 'public']) ??
					row.rawLine.match(/\bto\s+([^\s]+)\b/i)?.[1] ??
					null,
			)
			const internal = parseHostPort(
				findField(row.fields, ['internal', 'inside', 'private', 'target']) ??
					row.rawLine.match(/\b->\s*([^\s]+)\b/)?.[1] ??
					null,
			)
			if (
				!external.host &&
				!internal.host &&
				!findField(row.fields, ['rule', 'id', 'name'])
			) {
				return []
			}
			return [
				{
					ruleId: findField(row.fields, ['rule', 'id', 'name']),
					type: findField(row.fields, ['type', 'kind']),
					protocol:
						findField(row.fields, ['protocol', 'proto']) ??
						row.rawLine.match(/\b(tcp|udp|icmp|gre|esp)\b/i)?.[1] ??
						null,
					interfaceName:
						findField(row.fields, ['interface', 'iface', 'wan']) ??
						extractInterfaceName(row.rawLine),
					externalAddress: external.host,
					externalPort: external.port == null ? null : String(external.port),
					internalAddress: internal.host,
					internalPort: internal.port == null ? null : String(internal.port),
					enabled: parseEnabledFlag(
						findField(row.fields, ['enabled', 'status', 'state']) ?? row.rawLine,
					),
					description: findField(row.fields, ['description', 'desc', 'comment']),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterNatRule,
			]
		}),
	}
}

export function parseIslandRouterVlanConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterVlanConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		vlans: rows.flatMap((row) => {
			const vlanId =
				parseInteger(findField(row.fields, ['vlan', 'vlan_id', 'id'])) ??
				parseInteger(row.rawLine.match(/\bvlan\s*(\d+)\b/i)?.[1] ?? null)
			const interfaceName =
				findField(row.fields, ['interface', 'iface']) ??
				extractInterfaceName(row.rawLine)
			if (vlanId == null && !interfaceName) return []
			return [
				{
					vlanId,
					name: findField(row.fields, ['name', 'description', 'desc']),
					interfaceName,
					memberInterfaces: splitValueList(
						findField(row.fields, ['members', 'ports', 'interfaces']),
					),
					status: findField(row.fields, ['status', 'state']),
					ipAddress:
						findField(row.fields, ['ip', 'address']) ?? extractIpAddress(row.rawLine),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterVlanConfigEntry,
			]
		}),
	}
}

export function parseIslandRouterDnsConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterDnsConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	const rows = selectRowsOrFallback(lines)
	const servers: Array<IslandRouterDnsServer> = []
	const overrides: Array<IslandRouterDnsOverride> = []
	for (const row of rows) {
		const address =
			findField(row.fields, ['server', 'address', 'ip']) ??
			extractIpAddress(row.rawLine)
		const host =
			findField(row.fields, ['host', 'domain', 'name']) ??
			(/\b[a-z0-9_.-]+\.[a-z]{2,}\b/i.test(row.rawLine)
				? row.rawLine.match(/\b[a-z0-9_.-]+\.[a-z]{2,}\b/i)?.[0] ?? null
				: null)
		if (host && address) {
			overrides.push({
				host,
				recordType: findField(row.fields, ['record', 'type']),
				value: address,
				enabled: parseEnabledFlag(
					findField(row.fields, ['enabled', 'status']) ?? row.rawLine,
				),
				rawLine: row.rawLine,
				fields: row.fields,
			})
			continue
		}
		if (!address) continue
		servers.push({
			address,
			role: findField(row.fields, ['role', 'type']),
			source: findField(row.fields, ['source', 'origin']),
			rawLine: row.rawLine,
			fields: row.fields,
		})
	}
	return {
		mode: findField(fieldMap, ['mode', 'dns_mode']),
		searchDomains: splitValueList(
			findField(fieldMap, ['search_domain', 'search_domains']),
		),
		servers,
		overrides,
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterUsers(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterUsers {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		users: rows.flatMap((row) => {
			const username =
				findField(row.fields, ['user', 'username', 'name']) ??
				row.rawLine.match(/^\s*([a-z0-9_.-]+)/i)?.[1] ??
				null
			if (!username) return []
			return [
				{
					username,
					groupName: findField(row.fields, ['group', 'groups']),
					role: findField(row.fields, ['role', 'privilege', 'access']),
					connectionType: findField(
						row.fields,
						['connection', 'type', 'transport'],
					),
					address:
						findField(row.fields, ['address', 'ip', 'client']) ??
						extractIpAddress(row.rawLine),
					connected: parseEnabledFlag(
						findField(row.fields, ['connected', 'status']) ?? row.rawLine,
					),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterUserEntry,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterSecurityPolicy(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterSecurityPolicy {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		rules: rows.flatMap((row) => {
			const action =
				findField(row.fields, ['action', 'policy']) ??
				row.rawLine.match(/\b(allow|deny|drop|reject|block)\b/i)?.[1] ??
				null
			if (!action && !findField(row.fields, ['rule', 'id', 'name'])) return []
			return [
				{
					ruleId: findField(row.fields, ['rule', 'id']),
					name: findField(row.fields, ['name', 'description']),
					action,
					source:
						findField(row.fields, ['source', 'src']) ??
						row.rawLine.match(/\bsrc[:= ]+([^\s,]+)/i)?.[1] ??
						null,
					destination:
						findField(row.fields, ['destination', 'dest', 'dst']) ??
						row.rawLine.match(/\bdst[:= ]+([^\s,]+)/i)?.[1] ??
						null,
					service: findField(row.fields, ['service', 'port', 'application']),
					enabled: parseEnabledFlag(
						findField(row.fields, ['enabled', 'status']) ?? row.rawLine,
					),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterSecurityPolicyRule,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterQosConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterQosConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		policies: rows.flatMap((row) => {
			const policyName =
				findField(row.fields, ['policy', 'name']) ??
				row.rawLine.match(/^\s*([a-z0-9_.-]+)/i)?.[1] ??
				null
			if (!policyName && !extractInterfaceName(row.rawLine)) return []
			return [
				{
					policyName,
					interfaceName:
						findField(row.fields, ['interface', 'iface']) ??
						extractInterfaceName(row.rawLine),
					className: findField(row.fields, ['class', 'queue']),
					priority: findField(row.fields, ['priority', 'precedence']),
					bandwidth:
						findField(row.fields, ['bandwidth', 'rate']) ??
						extractRate(row.rawLine),
					enabled: parseEnabledFlag(
						findField(row.fields, ['enabled', 'status']) ?? row.rawLine,
					),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterQosPolicyEntry,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterTrafficStats(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterTrafficStats {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		interfaces: rows.flatMap((row) => {
			const interfaceName =
				findField(row.fields, ['interface', 'iface', 'name']) ??
				extractInterfaceName(row.rawLine)
			if (!interfaceName) return []
			return [
				{
					interfaceName,
					rxBytes: parseInteger(findField(row.fields, ['rx_bytes', 'bytes_in'])),
					txBytes: parseInteger(findField(row.fields, ['tx_bytes', 'bytes_out'])),
					rxPackets: parseInteger(
						findField(row.fields, ['rx_packets', 'packets_in']),
					),
					txPackets: parseInteger(
						findField(row.fields, ['tx_packets', 'packets_out']),
					),
					rxErrors: parseInteger(
						findField(row.fields, ['rx_errors', 'errors_in']),
					),
					txErrors: parseInteger(
						findField(row.fields, ['tx_errors', 'errors_out']),
					),
					utilizationPercent: parsePercent(
						findField(row.fields, ['utilization', 'utilization_percent']),
					),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterTrafficStat,
			]
		}),
	}
}

export function parseIslandRouterActiveSessions(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterActiveSessions {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		sessions: rows.flatMap((row) => {
			const source = parseHostPort(
				findField(row.fields, ['source', 'src', 'source_address']) ??
					row.rawLine.match(/\bsrc[:= ]+([^\s,]+)/i)?.[1] ??
					null,
			)
			const destination = parseHostPort(
				findField(row.fields, ['destination', 'dest', 'dst']) ??
					row.rawLine.match(/\bdst[:= ]+([^\s,]+)/i)?.[1] ??
					null,
			)
			const translated = parseHostPort(
				findField(row.fields, ['translated', 'nat', 'xlated']) ?? null,
			)
			if (!source.host && !destination.host) return []
			return [
				{
					protocol:
						findField(row.fields, ['protocol', 'proto']) ??
						row.rawLine.match(/\b(tcp|udp|icmp|gre|esp)\b/i)?.[1] ??
						null,
					sourceAddress: source.host,
					sourcePort: source.port,
					destinationAddress: destination.host,
					destinationPort: destination.port,
					translatedAddress: translated.host,
					translatedPort: translated.port,
					state: findField(row.fields, ['state', 'status']),
					interfaceName:
						findField(row.fields, ['interface', 'iface']) ??
						extractInterfaceName(row.rawLine),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterActiveSession,
			]
		}),
	}
}

export function parseIslandRouterVpnConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterVpnConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		tunnels: rows.flatMap((row) => {
			const tunnelName =
				findField(row.fields, ['name', 'tunnel', 'id']) ??
				row.rawLine.match(/^\s*([a-z0-9_.-]+)/i)?.[1] ??
				null
			const localEndpoint =
				findField(row.fields, ['local', 'local_endpoint']) ??
				extractIpAddress(row.rawLine)
			if (!tunnelName && !localEndpoint && !/ipsec|vpn|gre/i.test(row.rawLine)) {
				return []
			}
			const remoteMatch = row.rawLine.match(/\bto\s+([^\s,]+)/i)?.[1] ?? null
			return [
				{
					tunnelName,
					type:
						findField(row.fields, ['type', 'protocol']) ??
						row.rawLine.match(/\b(ipsec|vpn|gre)\b/i)?.[1] ??
						null,
					localEndpoint,
					remoteEndpoint:
						findField(row.fields, ['remote', 'peer', 'remote_endpoint']) ??
						remoteMatch,
					status: findField(row.fields, ['status', 'state']),
					interfaceName:
						findField(row.fields, ['interface', 'iface']) ??
						extractInterfaceName(row.rawLine),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterVpnTunnel,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterDhcpServerConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterDhcpServerConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	const pools: Array<IslandRouterDhcpServerPool> = []
	const options: Array<IslandRouterDhcpServerOption> = []
	const reservations: Array<IslandRouterDhcpLease> = []
	for (const row of rows) {
		const fields = row.fields
		const rawLower = row.rawLine.toLowerCase()
		if (findField(fields, ['mac', 'hardware_address']) || macAddressPattern.test(row.rawLine)) {
			reservations.push({
				ipAddress:
					findField(fields, ['ip', 'address']) ?? extractIpv4Address(row.rawLine),
				macAddress:
					findField(fields, ['mac', 'hardware_address'])?.toLowerCase() ??
					extractMacAddress(row.rawLine),
				hostName: findField(fields, ['host', 'hostname', 'name']),
				interfaceName:
					findField(fields, ['interface', 'iface']) ??
					extractInterfaceName(row.rawLine),
				leaseType: 'reservation',
				rawLine: row.rawLine,
				fields,
			})
			continue
		}
		if (rawLower.includes('option') || findField(fields, ['option'])) {
			options.push({
				poolName: findField(fields, ['pool', 'scope', 'name']),
				option: findField(fields, ['option', 'code', 'name']),
				value: findField(fields, ['value', 'setting']),
				rawLine: row.rawLine,
				fields,
			})
			continue
		}
		const poolName = findField(fields, ['pool', 'scope', 'name'])
		const network =
			findField(fields, ['network', 'subnet']) ?? extractCidr(row.rawLine)
		if (!poolName && !network && !rawLower.includes('pool')) continue
		pools.push({
			poolName,
			interfaceName:
				findField(fields, ['interface', 'iface']) ?? extractInterfaceName(row.rawLine),
			network,
			rangeStart:
				findField(fields, ['range_start', 'start']) ??
				row.rawLine.match(/\bstart[:= ]+([^\s,]+)/i)?.[1] ??
				null,
			rangeEnd:
				findField(fields, ['range_end', 'end']) ??
				row.rawLine.match(/\bend[:= ]+([^\s,]+)/i)?.[1] ??
				null,
			gateway:
				findField(fields, ['gateway', 'router']) ??
				row.rawLine.match(/\bgateway[:= ]+([^\s,]+)/i)?.[1] ??
				null,
			dnsServers: splitValueList(findField(fields, ['dns', 'dns_servers'])),
			rawLine: row.rawLine,
			fields,
		})
	}
	return {
		pools,
		options,
		reservations,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterNtpConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterNtpConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	const rows = selectRowsOrFallback(lines)
	return {
		timezone: findField(fieldMap, ['timezone', 'tz']),
		servers: rows.flatMap((row) => {
			const server =
				findField(row.fields, ['server', 'address', 'host']) ??
				extractIpAddress(row.rawLine)
			if (!server) return []
			return [
				{
					server,
					status: findField(row.fields, ['status', 'state']),
					source: findField(row.fields, ['source', 'type']),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterNtpServer,
			]
		}),
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterSyslogConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterSyslogConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const rows = selectRowsOrFallback(lines)
	return {
		targets: rows.flatMap((row) => {
			const hostPort = parseHostPort(
				findField(row.fields, ['host', 'server', 'target']) ??
					extractIpAddress(row.rawLine),
			)
			if (!hostPort.host) return []
			return [
				{
					host: hostPort.host,
					port:
						hostPort.port ??
						parseInteger(findField(row.fields, ['port'])) ??
						null,
					protocol: findField(row.fields, ['protocol', 'transport']),
					facility: findField(row.fields, ['facility']),
					enabled: parseEnabledFlag(
						findField(row.fields, ['enabled', 'status']) ?? row.rawLine,
					),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterSyslogTarget,
			]
		}),
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterSnmpConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterSnmpConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	const rows = selectRowsOrFallback(lines)
	const communities: Array<IslandRouterSnmpCommunity> = []
	const trapTargets: Array<IslandRouterSnmpTrapTarget> = []
	for (const row of rows) {
		if (/trap/i.test(row.rawLine) || findField(row.fields, ['trap', 'target'])) {
			const trapHost = parseHostPort(
				findField(row.fields, ['host', 'target', 'trap']) ??
					extractIpAddress(row.rawLine),
			)
			if (!trapHost.host) continue
			trapTargets.push({
				host: trapHost.host,
				version: findField(row.fields, ['version']),
				community: findField(row.fields, ['community']),
				rawLine: row.rawLine,
				fields: row.fields,
			})
			continue
		}
		const community = findField(row.fields, ['community', 'name'])
		if (!community) continue
		communities.push({
			community,
			access: findField(row.fields, ['access', 'permission']),
			source: findField(row.fields, ['source', 'host']),
			rawLine: row.rawLine,
			fields: row.fields,
		})
	}
	return {
		enabled:
			parseEnabledFlag(findField(fieldMap, ['enabled', 'status'])) ??
			(communities.length > 0 || trapTargets.length > 0 ? true : null),
		communities,
		trapTargets,
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterSystemInfo(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterSystemInfo {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const attributes = parseKeyValueLines(lines)
	const fieldMap = Object.fromEntries(
		attributes.map((entry) => [normalizeHeaderKey(entry.key), entry.value]),
	)
	const rawOutput = lines.join('\n')
	return {
		uptime:
			findField(fieldMap, ['uptime']) ??
			rawOutput.match(uptimePattern)?.[0] ??
			null,
		cpuUsagePercent: parsePercent(findField(fieldMap, ['cpu', 'cpu_usage'])),
		memoryUsagePercent: parsePercent(
			findField(fieldMap, ['memory', 'memory_usage', 'mem_usage']),
		),
		temperatureCelsius: parseNumber(
			findField(fieldMap, ['temperature', 'temp', 'temperature_celsius']),
		),
		attributes,
		rawOutput,
	}
}

export function parseIslandRouterBandwidthUsage(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterBandwidthUsage {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	const rows = selectRowsOrFallback(lines)
	return {
		entries: rows.flatMap((row) => {
			const interfaceName =
				findField(row.fields, ['interface', 'iface']) ??
				extractInterfaceName(row.rawLine)
			const subject =
				findField(row.fields, ['host', 'subject', 'name']) ??
				interfaceName ??
				null
			const rxRate =
				findField(row.fields, ['rx_rate', 'download', 'in']) ??
				extractRate(row.rawLine)
			const txRate =
				findField(row.fields, ['tx_rate', 'upload', 'out']) ??
				null
			if (!subject && !rxRate && !txRate) return []
			return [
				{
					subject,
					interfaceName,
					rxRate,
					txRate,
					totalRate: findField(row.fields, ['total_rate', 'rate', 'throughput']),
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterBandwidthUsageEntry,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}
