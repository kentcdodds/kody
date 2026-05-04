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
	type IslandRouterInterfaceDetails,
	type IslandRouterInterfaceSummary,
	type IslandRouterNeighborEntry,
	type IslandRouterNtpConfig,
	type IslandRouterNtpServer,
	type IslandRouterNatRule,
	type IslandRouterNatRules,
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
	/^(?<timestamp>\d{4}[/-]\d{2}[/-]\d{2}(?:[ T-])\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<rest>.*)$/
const macAddressPattern = /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/
const ipv4Pattern = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
const islandRouterVersionBannerPattern =
	/^(?<model>.+?)\s+\((?<hardwareModel>[^)]+)\)\s+serial number\s+(?<serialNumber>\S+)\s+Version\s+(?<firmwareVersion>\S+)$/i
const islandRouterCliFailurePattern =
	/\b(?:invalid command|unknown command|unrecognized command|syntax error|permission denied|host key verification failed|connection refused|no route to host|network is unreachable|could not resolve hostname|command not found|not recognized as an internal or external command|ambiguous command|incomplete command|requires additional parameters?)\b|(?:"[^"]+"|\S+)\s+is unknown\.\s+Try "\?"/i
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
const islandRouterHelpHeadingPattern =
	/^(?:syntax|syntax description|defaults|usage guidelines|examples|related commands)$/i
const islandRouterHelpSyntaxLinePattern =
	/^(?:show|help|interface|ip|syslog|snmp|vpn|ntp|qos|traffic-policy|firewall|protection|reload|write|clear|ping)\b.*(?:<[^>]+>|\[[^\]]+\]|\|)/i
const islandRouterHelpHintPattern =
	/(?:type "\?"|context-sensitive help|display .* information\.?$)/i

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

function isIslandRouterHelpOrUsageOutput(lines: Array<string>) {
	if (lines.length === 0) return false
	if (
		lines.some((line) =>
			islandRouterHelpHeadingPattern.test(normalizeWhitespace(line)),
		)
	) {
		return true
	}
	const syntaxLikeCount = lines.filter((line) =>
		islandRouterHelpSyntaxLinePattern.test(normalizeWhitespace(line)),
	).length
	const hintLikeCount = lines.filter((line) =>
		islandRouterHelpHintPattern.test(line),
	).length
	return (
		syntaxLikeCount > 0 &&
		syntaxLikeCount + hintLikeCount >= Math.max(1, Math.ceil(lines.length / 2))
	)
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

	const sanitized = relevantOutput.filter((line) => {
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
	return isIslandRouterHelpOrUsageOutput(sanitized) ? [] : sanitized
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

function parseTextTables(lines: Array<string>): Array<ParsedTable> {
	const tables: Array<ParsedTable> = []
	let index = 0

	while (index < lines.length - 1) {
		const line = lines[index] ?? ''
		const columns = splitTableColumns(line)
		const next = lines[index + 1] ?? ''
		if (
			columns.length < 2 ||
			!/^-{3,}(?:\s+-{3,})*$/.test(next.trim())
		) {
			index += 1
			continue
		}

		const headers = columns.map(normalizeHeaderKey)
		const rows: Array<ParsedTableRow> = []
		index += 2

		while (index < lines.length) {
			const currentLine = lines[index] ?? ''
			const currentColumns = splitTableColumns(currentLine)
			const upcomingLine = lines[index + 1] ?? ''
			if (
				currentColumns.length >= 2 &&
				!/^-{3,}(?:\s+-{3,})*$/.test(currentLine.trim()) &&
				/^-{3,}(?:\s+-{3,})*$/.test(upcomingLine.trim())
			) {
				break
			}
			if (!currentLine.trim()) {
				index += 1
				continue
			}
			if (/^-{3,}(?:\s+-{3,})*$/.test(currentLine.trim())) {
				index += 1
				continue
			}
			if (currentColumns.length < 2) {
				index += 1
				continue
			}
			if (
				currentColumns.length === headers.length &&
				currentColumns.every(
					(column, columnIndex) =>
						normalizeHeaderKey(column) === (headers[columnIndex] ?? ''),
				)
			) {
				index += 1
				continue
			}
			rows.push({
				rawLine: currentLine,
				fields: Object.fromEntries(
					headers.map((header, columnIndex) => [
						header,
						currentColumns[columnIndex] ?? '',
					]),
				),
			})
			index += 1
		}

		tables.push({
			headers,
			rows,
		})
	}

	return tables
}

function findTextTableRows(
	lines: Array<string>,
	requiredHeaders: Array<string>,
): Array<ParsedTableRow> {
	return (
		parseTextTables(lines).find((table) =>
			requiredHeaders.every((header) => table.headers.includes(header)),
		)?.rows ?? []
	)
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
		const numericLevelMatch = rest.match(/^(?<level>\d+)\s+(?<message>.*)$/)
		const normalizedRest =
			numericLevelMatch?.groups?.['message']?.trim() ?? rest
		const levelMatch = rest.match(
			/\b(?:emerg|alert|crit|err|warning|notice|info|debug)\b/i,
		)
		const moduleMatch = normalizedRest.match(/\b[a-z][a-z0-9_-]+(?=:)/i)
		return {
			timestamp: match?.groups?.['timestamp']?.trim() ?? null,
			level:
				numericLevelMatch?.groups?.['level'] ??
				levelMatch?.[0]?.toLowerCase() ??
				null,
			module: moduleMatch?.[0] ?? null,
			message: normalizedRest,
			rawLine: line,
		}
	})
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

function commandLinesContain(
	commandLines: Array<string>,
	expectedCommand: string,
) {
	const expected = normalizeWhitespace(expectedCommand)
	return commandLines.some(
		(command) => normalizeWhitespace(command) === expected,
	)
}

type RunningConfigInterfaceContext = {
	interfaceName: string
	lines: Array<string>
}

function parseRunningConfigContexts(lines: Array<string>) {
	const globals: Array<string> = []
	const interfaces: Array<RunningConfigInterfaceContext> = []
	let currentInterface: RunningConfigInterfaceContext | null = null

	for (const line of lines) {
		const normalized = normalizeWhitespace(line)
		const interfaceMatch = /^interface\s+(?<name>\S+)$/i.exec(normalized)
		if (interfaceMatch?.groups?.['name']) {
			currentInterface = {
				interfaceName: interfaceMatch.groups['name'],
				lines: [],
			}
			interfaces.push(currentInterface)
			continue
		}
		if (/^(?:end|exit)$/i.test(normalized)) {
			currentInterface = null
			continue
		}
		if (currentInterface) {
			currentInterface.lines.push(normalized)
		} else {
			globals.push(normalized)
		}
	}

	return {
		globals,
		interfaces,
	}
}

function getLinesBeforeFirstTable(lines: Array<string>) {
	for (let index = 0; index < lines.length - 1; index += 1) {
		const columns = splitTableColumns(lines[index] ?? '')
		const next = lines[index + 1] ?? ''
		if (
			columns.length >= 2 &&
			/^-{3,}(?:\s+-{3,})*$/.test(next.trim())
		) {
			return lines.slice(0, index)
		}
	}
	return lines
}

function getInterfaceConfigLine(
	context: RunningConfigInterfaceContext,
	pattern: RegExp,
) {
	return context.lines.find((line) => pattern.test(line)) ?? null
}

function parseRunningConfigWanInterfaces(lines: Array<string>) {
	const { interfaces } = parseRunningConfigContexts(lines)
	return interfaces.flatMap((context) => {
		const autoconfig = getInterfaceConfigLine(
			context,
			/^ip autoconfig (?:wan|static-wan|full)\b/i,
		)
		const dhcpClient = getInterfaceConfigLine(
			context,
			/^ip dhcp-client (?:on|off)\b/i,
		)
		const priority = getInterfaceConfigLine(context, /^ip priority \d+\b/i)
		const looksLikeWan =
			autoconfig != null ||
			dhcpClient != null ||
			priority != null ||
			/^wan\d+$/i.test(context.interfaceName)
		if (!looksLikeWan) return []

		const addressLine = getInterfaceConfigLine(
			context,
			/^ip address\s+\S+/i,
		)
		const connectionType =
			autoconfig == null
				? normalizeConnectionType(dhcpClient ?? addressLine ?? '')
				: /\bstatic-wan\b/i.test(autoconfig)
					? 'static'
					: /\bwan\b/i.test(autoconfig)
						? 'dhcp'
						: normalizeConnectionType(autoconfig)
		return [
			{
				ispName: null,
				interfaceName: context.interfaceName,
				ipAddress:
					addressLine?.match(/^ip address\s+(?<address>\S+)/i)?.groups?.[
						'address'
					] ?? null,
				gateway: null,
				connectionType,
				role: 'unknown' as const,
				failoverPriority: parseInteger(
					priority?.match(/^ip priority (?<priority>\d+)$/i)?.groups?.[
						'priority'
					] ?? null,
				),
				linkState: null,
				rawLine: [
					`interface ${context.interfaceName}`,
					...context.lines,
				].join(' '),
				fields: {
					interface: context.interfaceName,
					autoconfig:
						autoconfig?.replace(/^ip autoconfig\s+/i, '') ?? '',
					priority:
						priority?.match(/^ip priority (?<priority>\d+)$/i)?.groups?.[
							'priority'
						] ?? '',
				},
			} satisfies IslandRouterWanInterfaceConfig,
		]
	})
}

function parseRunningConfigFailover(
	lines: Array<string>,
): IslandRouterFailoverStatus {
	const { globals } = parseRunningConfigContexts(lines)
	const wans = parseRunningConfigWanInterfaces(lines).sort((left, right) => {
		const leftPriority = left.failoverPriority ?? Number.POSITIVE_INFINITY
		const rightPriority = right.failoverPriority ?? Number.POSITIVE_INFINITY
		return leftPriority - rightPriority
	})
	const preferredInterfaceName = wans[0]?.interfaceName ?? null
	const policy =
		globals
			.find((line) => /^ip load-sharing /i.test(line))
			?.replace(/^ip load-sharing\s+/i, '')
			.trim() ??
		(wans.length > 0 ? 'priority' : null)
	const healthChecks = wans.map((wan) => ({
		interfaceName: wan.interfaceName,
		ispName: wan.ispName,
		state: null,
		role: 'unknown' as const,
		failoverPriority: wan.failoverPriority,
		monitor: null,
		rawLine: wan.rawLine,
		fields: wan.fields,
	}))
	return {
		activeInterfaceName: null,
		activeIspName: null,
		policy,
		healthChecks,
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigDns(
	lines: Array<string>,
): IslandRouterDnsConfig {
	const attributes: Array<{ key: string; value: string }> = []
	const servers: Array<IslandRouterDnsServer> = []
	for (const line of lines) {
		const dnsModeMatch = /^ip dns mode (?<mode>.+)$/i.exec(line)
		if (dnsModeMatch?.groups?.['mode']) {
			attributes.push({
				key: 'Mode',
				value: dnsModeMatch.groups['mode'],
			})
			continue
		}
		const localOnlyMatch = /^ip dns local-only (?<value>\S+)$/i.exec(line)
		if (localOnlyMatch?.groups?.['value']) {
			attributes.push({
				key: 'Local Only',
				value: localOnlyMatch.groups['value'],
			})
			continue
		}
		const serverMatch =
			/^ip (?:(?:name-server)|(?:dns server)) (?<server>\S+)$/i.exec(line)
		if (serverMatch?.groups?.['server']) {
			servers.push({
				address: serverMatch.groups['server'],
				role: 'upstream',
				source: 'running-config',
				rawLine: line,
				fields: {},
			})
		}
	}
	return {
		mode:
			attributes.find((attribute) => attribute.key === 'Mode')?.value ?? null,
		searchDomains: [],
		servers,
		overrides: [],
		attributes,
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigSecurityPolicy(
	lines: Array<string>,
): IslandRouterSecurityPolicy {
	return {
		rules: lines.flatMap((line, index) => {
			if (!/^(?:firewall|protection|security-policy)\b/i.test(line)) return []
			return [
				{
					ruleId: String(index + 1),
					name: line.split(/\s+/).slice(0, 2).join(' '),
					action:
						line.match(/\b(allow|deny|drop|reject|block)\b/i)?.[1]?.toLowerCase() ??
						null,
					source: null,
					destination: null,
					service: null,
					enabled: !/^no\s+/i.test(line),
					rawLine: line,
					fields: {},
				} satisfies IslandRouterSecurityPolicyRule,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigQos(
	lines: Array<string>,
): IslandRouterQosConfig {
	return {
		policies: lines.flatMap((line) => {
			if (!/^(?:qos|traffic-policy)\b/i.test(line)) return []
			return [
				{
					policyName: line.split(/\s+/)[1] ?? null,
					interfaceName: extractInterfaceName(line),
					className: null,
					priority:
						line.match(/\b(high|medium|low|\d+)\b/i)?.[1]?.toLowerCase() ?? null,
					bandwidth: extractRate(line),
					enabled: !/^no\s+/i.test(line),
					rawLine: line,
					fields: {},
				} satisfies IslandRouterQosPolicyEntry,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigNatRules(
	lines: Array<string>,
): IslandRouterNatRules {
	const { interfaces } = parseRunningConfigContexts(lines)
	const natInterfaces = interfaces.filter((context) =>
		context.lines.some((line) => /^ip nat[46] on$/i.test(line)),
	)
	return {
		rules: natInterfaces.flatMap((context, index) => {
			const natLine = context.lines.find((line) => /^ip nat[46] on$/i.test(line))
			if (!natLine) return []
			return [
				{
					ruleId: String(index + 1),
					type: natLine.match(/\bnat(?<version>[46])\b/i)?.groups?.['version']
						? `nat${natLine.match(/\bnat(?<version>[46])\b/i)?.groups?.['version']}`
						: 'nat',
					protocol: null,
					interfaceName: context.interfaceName,
					externalAddress: null,
					externalPort: null,
					internalAddress: null,
					internalPort: null,
					enabled: true,
					description: null,
					rawLine: [`interface ${context.interfaceName}`, natLine].join(' '),
					fields: {},
				} satisfies IslandRouterNatRule,
			]
		}),
	}
}

function parseRunningConfigDhcpServer(
	lines: Array<string>,
): IslandRouterDhcpServerConfig {
	const { globals, interfaces } = parseRunningConfigContexts(lines)
	const pools: Array<IslandRouterDhcpServerPool> = []
	const options: Array<IslandRouterDhcpServerOption> = []
	const reservations: Array<IslandRouterDhcpLease> = []

	for (const context of interfaces) {
		const dhcpEnabled = getInterfaceConfigLine(
			context,
			/^ip dhcp-server on$/i,
		)
		if (!dhcpEnabled) continue
		const addressLine = getInterfaceConfigLine(
			context,
			/^ip address (?<address>\S+)$/i,
		)
		const scopeLine = getInterfaceConfigLine(
			context,
			/^ip dhcp-scope (?<range>.+)$/i,
		)
		const leaseLine = getInterfaceConfigLine(
			context,
			/^ip dhcp-lease (?<seconds>\d+)$/i,
		)
		pools.push({
			poolName: context.interfaceName,
			interfaceName: context.interfaceName,
			network: addressLine?.match(/^ip address (?<address>\S+)$/i)?.groups?.[
				'address'
			] ?? null,
			rangeStart:
				scopeLine?.match(/^ip dhcp-scope (?<start>\d+)(?:-(?<end>\d*))?$/i)
					?.groups?.['start'] ?? null,
			rangeEnd:
				scopeLine?.match(/^ip dhcp-scope (?<start>\d+)(?:-(?<end>\d*))?$/i)
					?.groups?.['end'] ?? null,
			gateway:
				addressLine?.match(/^ip address (?<address>\S+)$/i)?.groups?.['address'] ??
				null,
			dnsServers: [],
			rawLine: [`interface ${context.interfaceName}`, ...context.lines].join(' '),
			fields: {},
		})
		if (leaseLine) {
			options.push({
				poolName: context.interfaceName,
				option: 'lease-time',
				value:
					leaseLine.match(/^ip dhcp-lease (?<seconds>\d+)$/i)?.groups?.[
						'seconds'
					] ?? null,
				rawLine: leaseLine,
				fields: {},
			})
		}
	}

	for (const line of globals) {
		const reserveMatch =
			/^ip dhcp-reserve (?<ip>\S+) (?<mac>[0-9a-f:]+)$/i.exec(line)
		if (!reserveMatch?.groups) continue
		reservations.push({
			ipAddress: reserveMatch.groups['ip'] ?? null,
			macAddress: reserveMatch.groups['mac']?.toLowerCase() ?? null,
			hostName: null,
			interfaceName: null,
			leaseType: 'reservation',
			rawLine: line,
			fields: {},
		})
	}

	return {
		pools,
		options,
		reservations,
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigVlans(lines: Array<string>): IslandRouterVlanConfig {
	const { interfaces } = parseRunningConfigContexts(lines)
	return {
		vlans: interfaces.flatMap((context) => {
			const vlanMatch = /^vlan(?<id>\d+)$/i.exec(context.interfaceName)
			if (!vlanMatch?.groups?.['id']) return []
			const addressLine = getInterfaceConfigLine(
				context,
				/^ip address (?<address>\S+)$/i,
			)
			const parentLine = getInterfaceConfigLine(context, /^parent (?<parent>\S+)$/i)
			return [
				{
					vlanId: Number.parseInt(vlanMatch.groups['id'], 10),
					name: context.interfaceName,
					interfaceName: context.interfaceName,
					memberInterfaces: splitValueList(
						parentLine?.match(/^parent (?<parent>\S+)$/i)?.groups?.['parent'] ?? null,
					),
					status: null,
					ipAddress:
						addressLine?.match(/^ip address (?<address>\S+)$/i)?.groups?.['address'] ??
						null,
					rawLine: [`interface ${context.interfaceName}`, ...context.lines].join(' '),
					fields: {},
				} satisfies IslandRouterVlanConfigEntry,
			]
		}),
	}
}

function parseRunningConfigSyslog(
	lines: Array<string>,
): IslandRouterSyslogConfig {
	const hostLines: Array<string> = []
	let defaultPort: number | null = null
	let defaultProtocol: string | null = null
	let defaultFacility: string | null = null

	for (const line of lines) {
		const portMatch = /^syslog port (?<port>\d+)$/i.exec(line)
		if (portMatch?.groups?.['port']) {
			defaultPort = Number.parseInt(portMatch.groups['port'], 10)
			continue
		}
		const protocolMatch = /^syslog protocol (?<protocol>\S+)$/i.exec(line)
		if (protocolMatch?.groups?.['protocol']) {
			defaultProtocol = protocolMatch.groups['protocol'].toLowerCase()
			continue
		}
		const facilityMatch = /^syslog facility (?<facility>\S+)$/i.exec(line)
		if (facilityMatch?.groups?.['facility']) {
			defaultFacility = facilityMatch.groups['facility']
			continue
		}
		const hostMatch =
			/^syslog (?<host>(?!protocol\b|level\b|facility\b|port\b)\S+)$/i.exec(line)
		if (hostMatch?.groups?.['host']) {
			hostLines.push(line)
		}
	}

	return {
		targets: hostLines.map((line) => ({
			host:
				/^syslog (?<host>(?!protocol\b|level\b|facility\b|port\b)\S+)$/i.exec(line)
					?.groups?.['host'] ?? null,
			port: defaultPort,
			protocol: defaultProtocol,
			facility: defaultFacility,
			enabled: true,
			rawLine: line,
			fields: {},
		})),
		attributes: [],
		rawOutput: lines.join('\n'),
	}
}

function parseRunningConfigSnmp(
	lines: Array<string>,
): IslandRouterSnmpConfig {
	const communities: Array<IslandRouterSnmpCommunity> = []
	const trapTargets: Array<IslandRouterSnmpTrapTarget> = []

	for (const line of lines) {
		const communityMatch =
			/^snmp community (?<community>\S+)(?:\s+(?<access>\S+))?(?:\s+(?<source>\S+))?$/i.exec(
				line,
			)
		if (communityMatch?.groups?.['community']) {
			communities.push({
				community: communityMatch.groups['community'],
				access: communityMatch.groups['access'] ?? null,
				source: communityMatch.groups['source'] ?? null,
				rawLine: line,
				fields: {},
			})
			continue
		}
		const trapMatch =
			/^snmp trap(?:-target)? (?<host>\S+)(?:.*\bversion (?<version>\S+))?(?:.*\bcommunity (?<community>\S+))?$/i.exec(
				line,
			)
		if (trapMatch?.groups?.['host']) {
			trapTargets.push({
				host: trapMatch.groups['host'],
				version: trapMatch.groups['version'] ?? null,
				community: trapMatch.groups['community'] ?? null,
				rawLine: line,
				fields: {},
			})
		}
	}

	return {
		enabled: communities.length > 0 || trapTargets.length > 0 ? true : null,
		communities,
		trapTargets,
		attributes: [],
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterWanConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterWanConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	if (commandLinesContain(commandLines, 'show running-config')) {
		return {
			wans: parseRunningConfigWanInterfaces(lines),
		}
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigFailover(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigNatRules(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigVlans(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigDns(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigSecurityPolicy(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigQos(lines)
	}
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
	const rows = commandLinesContain(commandLines, 'show stats')
		? findTextTableRows(lines, ['interface', 'rx_bytes', 'tx_bytes'])
		: selectRowsOrFallback(lines)
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
				findField(row.fields, [
					'source',
					'src',
					'source_address',
					'local',
					'local_address',
				]) ??
					row.rawLine.match(/\bsrc[:= ]+([^\s,]+)/i)?.[1] ??
					null,
			)
			const destination = parseHostPort(
				findField(row.fields, [
					'destination',
					'dest',
					'dst',
					'foreign',
					'foreign_address',
					'remote',
				]) ??
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
			const status = findField(row.fields, ['status', 'state'])
			const interfaceName =
				findField(row.fields, ['interface', 'iface']) ??
				extractInterfaceName(row.rawLine)
			if (!tunnelName && !localEndpoint && !/ipsec|vpn|gre/i.test(row.rawLine)) {
				return []
			}
			if (!localEndpoint && !status && !interfaceName) {
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
					status,
					interfaceName,
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		const base = parseRunningConfigDhcpServer(getLinesBeforeFirstTable(lines))
		const reservationLines = lines.slice(getLinesBeforeFirstTable(lines).length)
		const reservations = parseIslandRouterDhcpReservations(
			reservationLines.join('\n'),
			['show ip dhcp'],
		)
		return {
			...base,
			reservations:
				reservations.length > 0 ? reservations : base.reservations,
		}
	}
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
	const parsedServers = rows.flatMap((row) => {
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
	})
	const fallbackServer = findField(fieldMap, ['server'])
	return {
		timezone: findField(fieldMap, ['timezone', 'tz']),
		servers:
			parsedServers.length > 0
				? parsedServers
				: fallbackServer == null
					? []
					: [
							{
								server: fallbackServer,
								status: findField(fieldMap, ['clock_state', 'status', 'state']),
								source: 'status',
								rawLine: `Server: ${fallbackServer}`,
								fields: {},
							} satisfies IslandRouterNtpServer,
						],
		attributes,
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterSyslogConfig(
	stdout: string,
	commandLines: Array<string>,
): IslandRouterSyslogConfig {
	const lines = sanitizeIslandRouterOutput(stdout, commandLines)
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigSyslog(lines)
	}
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
	if (commandLinesContain(commandLines, 'show running-config')) {
		return parseRunningConfigSnmp(lines)
	}
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
	const rows = commandLinesContain(commandLines, 'show stats')
		? findTextTableRows(lines, ['interface', 'rx_rate', 'tx_rate'])
		: selectRowsOrFallback(lines)
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
			const totalRate = findField(
				row.fields,
				['total_rate', 'rate', 'throughput'],
			)
			if (!rxRate && !txRate && !totalRate) return []
			return [
				{
					subject,
					interfaceName,
					rxRate,
					txRate,
					totalRate,
					rawLine: row.rawLine,
					fields: row.fields,
				} satisfies IslandRouterBandwidthUsageEntry,
			]
		}),
		rawOutput: lines.join('\n'),
	}
}

export function parseIslandRouterRawOutput(
	stdout: string,
	commandLines: Array<string>,
) {
	return {
		rawOutput: sanitizeIslandRouterOutput(stdout, commandLines).join('\n'),
	}
}
