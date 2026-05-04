import { isIP } from 'node:net'

export const islandRouterCommandConfirmation =
	'I understand this allowlisted Island router command may affect live network behavior.'

export const islandRouterCommandIds = [
	'show clock',
	'show version',
	'show running-config',
	'show running-config differences',
	'show startup-config',
	'show interface summary',
	'show interface',
	'show interface transceivers',
	'show ip interface',
	'show ip neighbors',
	'show ip recommendations',
	'show ip routes',
	'show ip sockets',
	'show ip dhcp-reservations',
	'show log',
	'show syslog',
	'show ntp',
	'show users',
	'show vpns',
	'show hardware',
	'show free-space',
	'show packages',
	'show dumps',
	'show public-key',
	'show ssh-client-keys',
	'show config authorized-keys',
	'show config known-hosts',
	'show stats',
	'ping',
	'clear dhcp-client',
	'clear log',
	'write memory',
	'ip dhcp-reserve',
	'no ip dhcp-reserve',
	'interface ip autoconfig',
	'interface description',
	'no interface description',
	'syslog server',
	'no syslog server',
	'ip port-forward',
] as const

export type IslandRouterCommandId = (typeof islandRouterCommandIds)[number]

export type IslandRouterCommandRiskLevel =
	| 'read'
	| 'lowWrite'
	| 'networkWrite'
	| 'destructive'

export type IslandRouterCommandAccess = 'read' | 'write'

export type IslandRouterCommandContext =
	| {
			mode: 'exec'
	  }
	| {
			mode: 'configureTerminal'
	  }
	| {
			mode: 'interface'
			interfaceParam: 'interfaceName'
	  }

export type IslandRouterCommandParamValidator =
	| 'enum'
	| 'host'
	| 'interfaceName'
	| 'ipv4Address'
	| 'macAddress'
	| 'macAddressOrIsland'
	| 'port'
	| 'quotedText'

export type IslandRouterCommandParam = {
	name: string
	description: string
	validator: IslandRouterCommandParamValidator
	required: true
	values?: ReadonlyArray<string>
	maxLength?: number
	renderAsBracketedHost?: true
}

export type IslandRouterCommandCatalogEntry = {
	id: IslandRouterCommandId
	cliTemplate: string
	access: IslandRouterCommandAccess
	riskLevel: IslandRouterCommandRiskLevel
	context: IslandRouterCommandContext
	params: ReadonlyArray<IslandRouterCommandParam>
	noVariantId: IslandRouterCommandId | null
	persistence: {
		requiresWriteMemory: boolean
		persistsRunningConfig: boolean
	}
	blastRadius: string
	operatorGuidance: string
	docsUrl: string | null
	supportsLineFilter?: true
}

export type RenderedIslandRouterCommand = {
	entry: IslandRouterCommandCatalogEntry
	commandLines: Array<string>
	normalizedParams: Record<string, string>
}

const docsBaseUrl =
	'https://docs.islandrouter.com/island-router-cli-2.3.2/commands'

const noParams: ReadonlyArray<IslandRouterCommandParam> = []

function readCommand(input: {
	id: IslandRouterCommandId
	cliTemplate?: string
	params?: ReadonlyArray<IslandRouterCommandParam>
	context?: IslandRouterCommandContext
	blastRadius: string
	operatorGuidance?: string
	docsPath: string
	supportsLineFilter?: true
}): IslandRouterCommandCatalogEntry {
	return {
		id: input.id,
		cliTemplate: input.cliTemplate ?? input.id,
		access: 'read',
		riskLevel: 'read',
		context: input.context ?? { mode: 'exec' },
		params: input.params ?? noParams,
		noVariantId: null,
		persistence: {
			requiresWriteMemory: false,
			persistsRunningConfig: false,
		},
		blastRadius: input.blastRadius,
		operatorGuidance:
			input.operatorGuidance ??
			'Read-only diagnostic command. Review output for sensitive LAN, policy, or configuration details before sharing.',
		docsUrl: `${docsBaseUrl}/${input.docsPath}`,
		...(input.supportsLineFilter ? { supportsLineFilter: true } : {}),
	}
}

function writeCommand(input: {
	id: IslandRouterCommandId
	cliTemplate?: string
	riskLevel: Exclude<IslandRouterCommandRiskLevel, 'read'>
	context?: IslandRouterCommandContext
	params?: ReadonlyArray<IslandRouterCommandParam>
	noVariantId?: IslandRouterCommandId | null
	requiresWriteMemory?: boolean
	persistsRunningConfig?: boolean
	blastRadius: string
	operatorGuidance: string
	docsPath: string
}): IslandRouterCommandCatalogEntry {
	return {
		id: input.id,
		cliTemplate: input.cliTemplate ?? input.id,
		access: 'write',
		riskLevel: input.riskLevel,
		context: input.context ?? { mode: 'exec' },
		params: input.params ?? noParams,
		noVariantId: input.noVariantId ?? null,
		persistence: {
			requiresWriteMemory: input.requiresWriteMemory ?? false,
			persistsRunningConfig: input.persistsRunningConfig ?? false,
		},
		blastRadius: input.blastRadius,
		operatorGuidance: input.operatorGuidance,
		docsUrl: `${docsBaseUrl}/${input.docsPath}`,
	}
}

const interfaceNameParam = {
	name: 'interfaceName',
	description:
		'Island interface name such as en0, en1, vlan14, bond0, br0, or a dotted subinterface.',
	validator: 'interfaceName',
	required: true,
} as const satisfies IslandRouterCommandParam

const ipAddressParam = {
	name: 'ipAddress',
	description: 'IPv4 address rendered as one CLI token.',
	validator: 'ipv4Address',
	required: true,
} as const satisfies IslandRouterCommandParam

const macAddressParam = {
	name: 'macAddress',
	description: 'MAC address rendered in lower-case colon notation.',
	validator: 'macAddress',
	required: true,
} as const satisfies IslandRouterCommandParam

const hostParam = {
	name: 'host',
	description: 'Hostname or IP address rendered as one CLI token.',
	validator: 'host',
	required: true,
} as const satisfies IslandRouterCommandParam

const bracketedHostParam = {
	...hostParam,
	description:
		'Hostname or IP address rendered as one CLI token. IPv6 literals are bracketed for host:port commands.',
	renderAsBracketedHost: true,
} as const satisfies IslandRouterCommandParam

const portParam = {
	name: 'port',
	description: 'TCP or UDP port number from 1 through 65535.',
	validator: 'port',
	required: true,
} as const satisfies IslandRouterCommandParam

export const islandRouterCommandCatalog = [
	readCommand({
		id: 'show clock',
		blastRadius: 'Reveals router-local date and time.',
		docsPath: 'show-clock.md',
	}),
	readCommand({
		id: 'show version',
		blastRadius:
			'Reveals router model, hardware, serial number, and firmware version.',
		docsPath: 'show-version.md',
	}),
	readCommand({
		id: 'show running-config',
		blastRadius:
			'Reveals the full live router configuration, including topology, policies, services, and network identifiers.',
		docsPath: 'show-running-config.md',
	}),
	readCommand({
		id: 'show running-config differences',
		blastRadius:
			'Reveals unsaved differences between running and startup configuration.',
		docsPath: 'show-running-config.md',
	}),
	readCommand({
		id: 'show startup-config',
		blastRadius:
			'Reveals the saved startup configuration that will load after reboot.',
		docsPath: 'show-startup-config.md',
	}),
	readCommand({
		id: 'show interface summary',
		blastRadius: 'Reveals physical interface names, link state, and labels.',
		docsPath: 'show-interface-summary.md',
	}),
	readCommand({
		id: 'show interface',
		cliTemplate: 'show interface {interfaceName}',
		params: [interfaceNameParam],
		blastRadius:
			'Reveals detailed link state and physical attributes for one interface.',
		docsPath: 'show-interface.md',
	}),
	readCommand({
		id: 'show interface transceivers',
		blastRadius: 'Reveals transceiver inventory and physical link metadata.',
		docsPath: 'show-interface-transceivers.md',
	}),
	readCommand({
		id: 'show ip interface',
		cliTemplate: 'show ip interface {interfaceName}',
		params: [interfaceNameParam],
		blastRadius:
			'Reveals addressing, DHCP, and routing-adjacent state for one interface.',
		docsPath: 'show-ip-interface.md',
	}),
	readCommand({
		id: 'show ip neighbors',
		blastRadius: 'Reveals LAN device IP and MAC address associations.',
		docsPath: 'show-ip-neighbors.md',
	}),
	readCommand({
		id: 'show ip recommendations',
		blastRadius: 'Reveals router-generated interface configuration guidance.',
		docsPath: 'show-ip-recommendations.md',
	}),
	readCommand({
		id: 'show ip routes',
		blastRadius: 'Reveals WAN gateways and internal routed prefixes.',
		docsPath: 'show-ip-routes.md',
	}),
	readCommand({
		id: 'show ip sockets',
		blastRadius:
			'Reveals router-local listening and connected sockets, not a LAN client session table.',
		docsPath: 'show-ip-sockets.md',
	}),
	readCommand({
		id: 'show ip dhcp-reservations',
		blastRadius: 'Reveals DHCP reservation IP and MAC address mappings.',
		docsPath: 'show-ip-dhcp-reservations.md',
	}),
	readCommand({
		id: 'show log',
		blastRadius:
			'Reveals recent operational history, host identifiers, addresses, and policy names.',
		docsPath: 'show-log.md',
		supportsLineFilter: true,
	}),
	readCommand({
		id: 'show syslog',
		blastRadius: 'Reveals persisted system log files.',
		docsPath: 'show-syslog.md',
		supportsLineFilter: true,
	}),
	readCommand({
		id: 'show ntp',
		blastRadius: 'Reveals NTP process and time source state.',
		docsPath: 'show-ntp.md',
	}),
	readCommand({
		id: 'show users',
		blastRadius: 'Reveals management connection information.',
		docsPath: 'show-users.md',
	}),
	readCommand({
		id: 'show vpns',
		blastRadius: 'Reveals configured VPN names and state.',
		docsPath: 'show-vpns.md',
	}),
	readCommand({
		id: 'show hardware',
		blastRadius: 'Reveals router hardware inventory and platform details.',
		docsPath: 'show-hardware.md',
	}),
	readCommand({
		id: 'show free-space',
		blastRadius: 'Reveals internal storage utilization.',
		docsPath: 'show-free-space.md',
	}),
	readCommand({
		id: 'show packages',
		blastRadius: 'Reveals installed package inventory.',
		docsPath: 'show-packages.md',
	}),
	readCommand({
		id: 'show dumps',
		blastRadius: 'Reveals crash dump inventory.',
		docsPath: 'show-dumps.md',
	}),
	readCommand({
		id: 'show public-key',
		blastRadius: "Reveals the Island's public key.",
		docsPath: 'show-public-key.md',
	}),
	readCommand({
		id: 'show ssh-client-keys',
		blastRadius: "Reveals the user's SSH public keys.",
		docsPath: 'show-ssh-client-keys.md',
	}),
	readCommand({
		id: 'show config authorized-keys',
		blastRadius: 'Reveals authorized SSH public keys.',
		docsPath: 'show-config-authorized-keys.md',
	}),
	readCommand({
		id: 'show config known-hosts',
		blastRadius: 'Reveals known SSH hosts and public keys.',
		docsPath: 'show-config-known-hosts.md',
	}),
	readCommand({
		id: 'show stats',
		blastRadius: 'Reveals system and interface counters and rates.',
		docsPath: 'show-stats.md',
	}),
	readCommand({
		id: 'ping',
		cliTemplate: 'ping {host}',
		params: [hostParam],
		blastRadius:
			'Sends ICMP echo requests from the router until the command exits or the connector timeout stops the session.',
		operatorGuidance:
			'Use a short timeout and prefer well-known diagnostic hosts. The command is read-risk but can create small network traffic.',
		docsPath: 'ping.md',
	}),
	writeCommand({
		id: 'clear dhcp-client',
		riskLevel: 'networkWrite',
		blastRadius:
			'Forces renewal of DHCP-learned router addresses and can briefly disrupt WAN or interface connectivity.',
		operatorGuidance:
			'Use only for a specific DHCP recovery need after checking current interface and route state.',
		docsPath: 'clear-dhcp-client.md',
	}),
	writeCommand({
		id: 'clear log',
		riskLevel: 'destructive',
		blastRadius:
			'Permanently clears the in-memory system log buffer and removes recent diagnostic evidence.',
		operatorGuidance:
			'Capture needed log output first. Do not use during incident investigation unless clearing the buffer is the explicit goal.',
		docsPath: 'clear-log.md',
	}),
	writeCommand({
		id: 'write memory',
		riskLevel: 'networkWrite',
		persistsRunningConfig: true,
		blastRadius:
			'Persists the current running configuration to startup configuration, making live mistakes survive reboot.',
		operatorGuidance:
			'Run only after reviewing running-config differences and confirming the live state should become the boot state.',
		docsPath: 'write/write-memory.md',
	}),
	writeCommand({
		id: 'ip dhcp-reserve',
		cliTemplate: 'ip dhcp-reserve {ipAddress} {macAddress}',
		riskLevel: 'networkWrite',
		context: { mode: 'configureTerminal' },
		params: [ipAddressParam, macAddressParam],
		noVariantId: 'no ip dhcp-reserve',
		requiresWriteMemory: true,
		blastRadius:
			'Changes DHCP assignment behavior for one MAC address and can conflict with existing leases or scopes.',
		operatorGuidance:
			'Confirm the IP belongs on an Island interface and is not already assigned before adding the reservation.',
		docsPath: 'ip-global-context/ip-dhcp-reserve.md',
	}),
	writeCommand({
		id: 'no ip dhcp-reserve',
		cliTemplate: 'no ip dhcp-reserve {ipAddress} {macAddress}',
		riskLevel: 'networkWrite',
		context: { mode: 'configureTerminal' },
		params: [ipAddressParam, macAddressParam],
		requiresWriteMemory: true,
		blastRadius:
			'Removes a DHCP reservation, allowing future leases for that device to change.',
		operatorGuidance:
			'Confirm this is the exact reservation to remove and that dependent devices can tolerate address changes.',
		docsPath: 'ip-global-context/ip-dhcp-reserve.md',
	}),
	writeCommand({
		id: 'interface ip autoconfig',
		cliTemplate: 'ip autoconfig {mode}',
		riskLevel: 'networkWrite',
		context: { mode: 'interface', interfaceParam: 'interfaceName' },
		params: [
			interfaceNameParam,
			{
				name: 'mode',
				description: 'Island interface autoconfiguration mode.',
				validator: 'enum',
				required: true,
				values: [
					'disabled',
					'full',
					'lan',
					'lan-no-dhcp',
					'manual',
					'static-wan',
					'wan',
				],
			},
		],
		requiresWriteMemory: true,
		blastRadius:
			'Changes interface role and can disrupt LAN, WAN, DHCP, routing, or management reachability.',
		operatorGuidance:
			'Verify the physical interface and intended role before changing autoconfiguration.',
		docsPath: 'ip-interface-context/ip-autoconfig.md',
	}),
	writeCommand({
		id: 'interface description',
		cliTemplate: 'description {description}',
		riskLevel: 'lowWrite',
		context: { mode: 'interface', interfaceParam: 'interfaceName' },
		params: [
			interfaceNameParam,
			{
				name: 'description',
				description:
					'Interface description text. It is quoted by the renderer and may not contain quotes or control characters.',
				validator: 'quotedText',
				required: true,
				maxLength: 80,
			},
		],
		noVariantId: 'no interface description',
		requiresWriteMemory: true,
		blastRadius:
			'Changes interface label text only, but the change is still a router configuration mutation.',
		operatorGuidance:
			'Use concise labels that do not expose unnecessary private details.',
		docsPath: 'description.md',
	}),
	writeCommand({
		id: 'no interface description',
		cliTemplate: 'no description',
		riskLevel: 'lowWrite',
		context: { mode: 'interface', interfaceParam: 'interfaceName' },
		params: [interfaceNameParam],
		requiresWriteMemory: true,
		blastRadius:
			'Removes interface label text only, but the change is still a router configuration mutation.',
		operatorGuidance:
			'Confirm the selected interface before removing its description.',
		docsPath: 'description.md',
	}),
	writeCommand({
		id: 'syslog server',
		cliTemplate: 'syslog server {host}:{port}',
		riskLevel: 'lowWrite',
		context: { mode: 'configureTerminal' },
		params: [bracketedHostParam, portParam],
		noVariantId: 'no syslog server',
		requiresWriteMemory: true,
		blastRadius:
			'Changes where router logs are sent and may expose operational logs to the configured host.',
		operatorGuidance:
			'Confirm the syslog collector host, port, and transport settings before enabling forwarding.',
		docsPath: 'syslog/syslog-server.md',
	}),
	writeCommand({
		id: 'no syslog server',
		cliTemplate: 'no syslog server {host}:{port}',
		riskLevel: 'lowWrite',
		context: { mode: 'configureTerminal' },
		params: [bracketedHostParam, portParam],
		requiresWriteMemory: true,
		blastRadius:
			'Stops forwarding logs to the specified external syslog server.',
		operatorGuidance:
			'Confirm no monitoring or archival process depends on this syslog destination.',
		docsPath: 'syslog/syslog-server.md',
	}),
	writeCommand({
		id: 'ip port-forward',
		cliTemplate:
			'ip port-forward {protocol} {publicPort} {target} {destinationPort}',
		riskLevel: 'networkWrite',
		context: { mode: 'configureTerminal' },
		params: [
			{
				name: 'protocol',
				description: 'Port-forward protocol.',
				validator: 'enum',
				required: true,
				values: ['tcp', 'udp'],
			},
			{
				name: 'publicPort',
				description:
					'Public TCP or UDP port accepted by Island, from 1 through 65535.',
				validator: 'port',
				required: true,
			},
			{
				name: 'target',
				description:
					'Destination device MAC address in colon notation, or the literal island.',
				validator: 'macAddressOrIsland',
				required: true,
			},
			{
				name: 'destinationPort',
				description:
					'Destination TCP or UDP port on the target, from 1 through 65535.',
				validator: 'port',
				required: true,
			},
		],
		requiresWriteMemory: true,
		blastRadius:
			'Opens inbound access through Island firewall/NAT to an internal device or Island itself.',
		operatorGuidance:
			'Confirm WAN exposure, target identity, and management/VPN port conflicts before adding a port-forward.',
		docsPath: 'ip-global-context/ip-port-forward.md',
	}),
] as const satisfies ReadonlyArray<IslandRouterCommandCatalogEntry>

function assertIslandRouterCommandCatalogComplete() {
	const catalogIds = new Set(islandRouterCommandCatalog.map((entry) => entry.id))
	const missingCatalogEntries = islandRouterCommandIds.filter(
		(id) => !catalogIds.has(id),
	)
	if (missingCatalogEntries.length > 0) {
		throw new Error(
			`Island router command catalog is missing entries for: ${missingCatalogEntries.join(', ')}`,
		)
	}
}

assertIslandRouterCommandCatalogComplete()

export function getIslandRouterCommandCatalogEntry(id: IslandRouterCommandId) {
	const entry = islandRouterCommandCatalog.find((candidate) => candidate.id === id)
	if (!entry) {
		throw new Error(`Unsupported Island router command id: ${id}`)
	}
	return entry
}

function hasControlCharacter(value: string) {
	for (const char of value) {
		const code = char.charCodeAt(0)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

function normalizeStringParam(value: unknown, name: string) {
	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new Error(`${name} must be a string or number.`)
	}
	const trimmed = String(value).trim()
	if (trimmed.length === 0) {
		throw new Error(`${name} must not be empty.`)
	}
	if (hasControlCharacter(trimmed)) {
		throw new Error(`${name} must not contain control characters.`)
	}
	return trimmed
}

function normalizeInterfaceName(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(trimmed)) {
		throw new Error(
			`${name} must be a single Island interface token such as en0, vlan14, or bond0.`,
		)
	}
	return trimmed
}

function normalizeIpv4Address(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (isIP(trimmed) !== 4) {
		throw new Error(`${name} must be a valid IPv4 address.`)
	}
	return trimmed
}

function normalizeMacAddress(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (!/^[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}$/.test(trimmed)) {
		throw new Error(`${name} must be a valid MAC address.`)
	}
	return trimmed.toLowerCase().replaceAll('-', ':')
}

function normalizeHost(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (isIP(trimmed) === 4 || isIP(trimmed) === 6) return trimmed.toLowerCase()
	if (
		/^(?=.{1,253}$)(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
			trimmed,
		)
	) {
		return trimmed.toLowerCase()
	}
	throw new Error(`${name} must be a valid IP address or hostname.`)
}

function normalizePort(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`${name} must be an integer port number.`)
	}
	const port = Number(trimmed)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${name} must be between 1 and 65535.`)
	}
	return String(port)
}

function normalizeEnumParam(
	value: unknown,
	param: IslandRouterCommandParam,
) {
	const trimmed = normalizeStringParam(value, param.name)
	const values = param.values ?? []
	if (!values.includes(trimmed)) {
		throw new Error(
			`${param.name} must be one of: ${values.map((item) => `"${item}"`).join(', ')}.`,
		)
	}
	return trimmed
}

function normalizeQuotedText(value: unknown, param: IslandRouterCommandParam) {
	const trimmed = normalizeStringParam(value, param.name)
	const maxLength = param.maxLength ?? 120
	if (trimmed.length > maxLength) {
		throw new Error(`${param.name} must be ${maxLength} characters or fewer.`)
	}
	if (/["\\]/.test(trimmed)) {
		throw new Error(`${param.name} must not contain quotes or backslashes.`)
	}
	return trimmed
}

function normalizeMacAddressOrIsland(value: unknown, name: string) {
	const trimmed = normalizeStringParam(value, name)
	if (trimmed.toLowerCase() === 'island') return 'island'
	return normalizeMacAddress(trimmed, name)
}

function normalizeParam(value: unknown, param: IslandRouterCommandParam) {
	switch (param.validator) {
		case 'enum':
			return normalizeEnumParam(value, param)
		case 'host':
			return normalizeHost(value, param.name)
		case 'interfaceName':
			return normalizeInterfaceName(value, param.name)
		case 'ipv4Address':
			return normalizeIpv4Address(value, param.name)
		case 'macAddress':
			return normalizeMacAddress(value, param.name)
		case 'macAddressOrIsland':
			return normalizeMacAddressOrIsland(value, param.name)
		case 'port':
			return normalizePort(value, param.name)
		case 'quotedText':
			return normalizeQuotedText(value, param)
		default: {
			const _exhaustive: never = param.validator
			throw new Error(
				`Unhandled Island router command parameter validator: ${String(_exhaustive)}`,
			)
		}
	}
}

function renderTemplate(
	template: string,
	normalizedParams: Record<string, string>,
	paramDefinitions: ReadonlyArray<IslandRouterCommandParam>,
) {
	const paramsByName = new Map(paramDefinitions.map((param) => [param.name, param]))
	return template.replaceAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name: string) => {
		const value = normalizedParams[name]
		if (value == null) {
			throw new Error(`Missing rendered Island router command parameter: ${name}`)
		}
		const param = paramsByName.get(name)
		if (param?.validator === 'quotedText') {
			return `"${value}"`
		}
		if (param?.renderAsBracketedHost && value.includes(':')) {
			return `[${value}]`
		}
		return value
	})
}

export function renderIslandRouterCommand(input: {
	id: IslandRouterCommandId
	params?: Record<string, unknown>
}): RenderedIslandRouterCommand {
	const entry = getIslandRouterCommandCatalogEntry(input.id)
	const params = input.params ?? {}
	const allowedParamNames = new Set(entry.params.map((param) => param.name))
	const unsupportedParams = Object.keys(params).filter(
		(name) => !allowedParamNames.has(name),
	)
	if (unsupportedParams.length > 0) {
		throw new Error(
			`${entry.id} does not accept parameter(s): ${unsupportedParams.join(', ')}.`,
		)
	}

	const normalizedParams: Record<string, string> = {}
	for (const param of entry.params) {
		if (params[param.name] == null) {
			throw new Error(`${entry.id} requires parameter: ${param.name}.`)
		}
		normalizedParams[param.name] = normalizeParam(params[param.name], param)
	}

	const command = renderTemplate(entry.cliTemplate, normalizedParams, entry.params)
	switch (entry.context.mode) {
		case 'exec':
			return {
				entry,
				commandLines: [command],
				normalizedParams,
			}
		case 'configureTerminal':
			return {
				entry,
				commandLines: ['configure terminal', command, 'end'],
				normalizedParams,
			}
		case 'interface': {
			const interfaceName = normalizedParams[entry.context.interfaceParam]
			if (!interfaceName) {
				throw new Error(
					`${entry.id} requires interface context parameter: ${entry.context.interfaceParam}.`,
				)
			}
			return {
				entry,
				commandLines: [
					'configure terminal',
					`interface ${interfaceName}`,
					command,
					'end',
				],
				normalizedParams,
			}
		}
		default: {
			const _exhaustive: never = entry.context
			throw new Error(
				`Unhandled Island router command context: ${String(_exhaustive)}`,
			)
		}
	}
}
