import {
	type IslandRouterDhcpLease,
	type IslandRouterHostIdentity,
	type IslandRouterInterfaceDetails,
	type IslandRouterInterfaceSummary,
	type IslandRouterNeighborEntry,
	type IslandRouterPingReply,
	type IslandRouterPingResult,
	type IslandRouterRecentEvent,
	type IslandRouterVersionInfo,
} from './types.ts'

type ParsedTableRow = {
	rawLine: string
	fields: Record<string, string>
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
	/\b(?:invalid command|unknown command|syntax error|permission denied|host key verification failed|connection refused|connection timed out|connection closed|no route to host|network is unreachable|could not resolve hostname|not found|not recognized)\b/i
const islandRouterPromptSuffixPattern = '[>#\\]]'

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
	return new RegExp(`^[^\\r\\n]+${islandRouterPromptSuffixPattern}$`).test(
		trimmed,
	)
}

export function sanitizeIslandRouterOutput(
	stdout: string,
	commandLines: Array<string>,
) {
	const normalizedCommands = commandLines
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean)
	const firstCommandEchoIndex = stdout
		.replaceAll(/\u001b\[[0-9;]*m/g, '')
		.split(/\r?\n/)
		.map((line) => line.replace(/\r/g, ''))
		.findIndex((line) =>
			normalizedCommands.some((command) => isPromptEchoLine(line, command)),
		)
	const relevantOutput =
		firstCommandEchoIndex >= 0
			? stdout
					.replaceAll(/\u001b\[[0-9;]*m/g, '')
					.split(/\r?\n/)
					.map((line) => line.replace(/\r/g, ''))
					.slice(firstCommandEchoIndex)
			: stdout
					.replaceAll(/\u001b\[[0-9;]*m/g, '')
					.split(/\r?\n/)
					.map((line) => line.replace(/\r/g, ''))

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
