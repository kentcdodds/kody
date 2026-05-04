export type IslandRouterVerificationMode =
	| 'known-hosts'
	| 'fingerprint'
	| 'none'

export const islandRouterReadCommandStrings = [
	'show ip neighbors',
	'show ip sockets',
	'show stats',
	'show interface <iface>',
	'show ip interface <iface>',
	'show log',
	'show running-config',
	'show running-config differences',
	'show ip dhcp',
	'show ip routes',
	'show ip recommendations',
] as const

export type IslandRouterReadCommand =
	(typeof islandRouterReadCommandStrings)[number]

export type IslandRouterReadCommandCatalogEntry = {
	command: IslandRouterReadCommand
	readOnly: true
	params: Array<'interfaceName' | 'query' | 'limit'>
	riskLevel: 'low' | 'medium'
	description: string
	riskNotes: string
}

export const islandRouterReadCommandCatalog = [
	{
		command: 'show ip neighbors',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read the IP neighbor cache.',
		riskNotes: 'May reveal LAN device IP and MAC addresses.',
	},
	{
		command: 'show ip sockets',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read local/control-plane socket state.',
		riskNotes:
			'This is not a LAN client session table; it may reveal router-local listening and connected sockets.',
	},
	{
		command: 'show stats',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read system and interface statistics.',
		riskNotes: 'May reveal interface traffic counters and rates.',
	},
	{
		command: 'show interface <iface>',
		readOnly: true,
		params: ['interfaceName'],
		riskLevel: 'low',
		description: 'Read details for one named interface.',
		riskNotes: 'May reveal interface link state and labels.',
	},
	{
		command: 'show ip interface <iface>',
		readOnly: true,
		params: ['interfaceName'],
		riskLevel: 'low',
		description: 'Read IP details for one named interface.',
		riskNotes: 'May reveal addressing and DHCP state for the interface.',
	},
	{
		command: 'show log',
		readOnly: true,
		params: ['query', 'limit'],
		riskLevel: 'medium',
		description: 'Read router log output with optional Kody-side filtering.',
		riskNotes:
			'May reveal host identifiers, addresses, policy names, and operational history.',
	},
	{
		command: 'show running-config',
		readOnly: true,
		params: [],
		riskLevel: 'medium',
		description: 'Read the live running configuration.',
		riskNotes:
			'May reveal complete network topology, policy, resolver, VPN, and service configuration.',
	},
	{
		command: 'show running-config differences',
		readOnly: true,
		params: [],
		riskLevel: 'medium',
		description: 'Read pending differences from saved configuration.',
		riskNotes:
			'May reveal unsaved operational changes and sensitive configuration context.',
	},
	{
		command: 'show ip dhcp',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read documented DHCP information.',
		riskNotes: 'May reveal DHCP leases or reservations when firmware includes them.',
	},
	{
		command: 'show ip routes',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read the IP routing table.',
		riskNotes: 'May reveal WAN gateways and internal prefixes.',
	},
	{
		command: 'show ip recommendations',
		readOnly: true,
		params: [],
		riskLevel: 'low',
		description: 'Read documented IP recommendations.',
		riskNotes: 'May reveal router-generated network diagnostics.',
	},
] as const satisfies ReadonlyArray<IslandRouterReadCommandCatalogEntry>

export const islandRouterWriteOperationStrings = [
	'renew dhcp clients',
	'clear log buffer',
	'save running config',
] as const

export type IslandRouterWriteOperation =
	(typeof islandRouterWriteOperationStrings)[number]

export type IslandRouterWriteOperationCatalogEntry = {
	operation: IslandRouterWriteOperation
	command: string
	riskLevel: 'high'
	description: string
	blastRadius: string
}

export const islandRouterWriteOperationCatalog = [
	{
		operation: 'renew dhcp clients',
		command: 'clear dhcp-client',
		riskLevel: 'high',
		description: 'Request immediate renewal of DHCP-learned router addresses.',
		blastRadius:
			'Can briefly disrupt DHCP-learned WAN or interface addressing and may interrupt connectivity while leases renew.',
	},
	{
		operation: 'clear log buffer',
		command: 'clear log',
		riskLevel: 'high',
		description: 'Clear the in-memory Island router log buffer.',
		blastRadius:
			'Permanently removes current local diagnostics, making recent incident reconstruction harder.',
	},
	{
		operation: 'save running config',
		command: 'write memory',
		riskLevel: 'high',
		description: 'Persist the current running configuration to startup storage.',
		blastRadius:
			'Can make a bad live configuration survive reboot until manually corrected.',
	},
] as const satisfies ReadonlyArray<IslandRouterWriteOperationCatalogEntry>

export type IslandRouterConfigStatus = {
	configured: boolean
	missingFields: Array<string>
	verificationMode: IslandRouterVerificationMode
	warnings: Array<string>
	writeCapabilitiesAvailable: boolean
	writeWarnings: Array<string>
}

export type IslandRouterCommandId =
	| 'show-version'
	| 'show-clock'
	| 'show-stats'
	| 'show-running-config'
	| 'show-running-config-differences'
	| 'show-interface-summary'
	| 'show-interface'
	| 'show-ip-interface'
	| 'show-ip-routes'
	| 'show-ip-neighbors'
	| 'show-ip-sockets'
	| 'show-log'
	| 'show-ip-dhcp'
	| 'show-ip-recommendations'
	| 'clear-dhcp-client'
	| 'clear-log'
	| 'write-memory'

export type IslandRouterCommandRequest =
	| {
			id: 'show-version'
			timeoutMs?: number
	  }
	| {
			id: 'show-clock'
			timeoutMs?: number
	  }
	| {
			id: 'show-stats'
			timeoutMs?: number
	  }
	| {
			id: 'show-running-config'
			timeoutMs?: number
	  }
	| {
			id: 'show-running-config-differences'
			timeoutMs?: number
	  }
	| {
			id: 'show-interface-summary'
			timeoutMs?: number
	  }
	| {
			id: 'show-interface'
			interfaceName: string
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-interface'
			interfaceName: string
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-routes'
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-neighbors'
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-sockets'
			timeoutMs?: number
	  }
	| {
			id: 'show-log'
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-dhcp'
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-recommendations'
			timeoutMs?: number
	  }
	| {
			id: 'clear-dhcp-client'
			timeoutMs?: number
	  }
	| {
			id: 'clear-log'
			timeoutMs?: number
	  }
	| {
			id: 'write-memory'
			timeoutMs?: number
	  }

export type IslandRouterCommandResult = {
	id: IslandRouterCommandId
	commandLines: Array<string>
	stdout: string
	stderr: string
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
	durationMs: number
}

export type IslandRouterCommandRunner = (
	request: IslandRouterCommandRequest,
) => Promise<IslandRouterCommandResult>

export type IslandRouterWriteOperationId =
	| 'renew-dhcp-clients'
	| 'clear-log-buffer'
	| 'save-running-config'

export type IslandRouterWriteOperationResult = {
	operationId: IslandRouterWriteOperationId
	commandId: Extract<
		IslandRouterCommandId,
		'clear-dhcp-client' | 'clear-log' | 'write-memory'
	>
	catalogEntry: IslandRouterWriteOperationCatalogEntry
	commandLines: Array<string>
	stdout: string
	stderr: string
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
	durationMs: number
}

export type IslandRouterKeyValue = {
	key: string
	value: string
}

export type IslandRouterInterfaceSummary = {
	name: string | null
	linkState: string | null
	speed: string | null
	duplex: string | null
	description: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterInterfaceDetails = {
	interfaceName: string | null
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterNeighborEntry = {
	ipAddress: string | null
	macAddress: string | null
	interfaceName: string | null
	state: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterDhcpLease = {
	ipAddress: string | null
	macAddress: string | null
	hostName: string | null
	interfaceName: string | null
	leaseType: 'reservation' | 'lease' | 'unknown'
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterRecentEvent = {
	timestamp: string | null
	level: string | null
	module: string | null
	message: string
	rawLine: string
}

export type IslandRouterVersionInfo = {
	model: string | null
	serialNumber: string | null
	firmwareVersion: string | null
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterWanRole = 'active' | 'standby' | 'unknown'

export type IslandRouterWanConnectionType =
	| 'dhcp'
	| 'static'
	| 'pppoe'
	| 'unknown'

export type IslandRouterWanInterfaceConfig = {
	ispName: string | null
	interfaceName: string | null
	ipAddress: string | null
	gateway: string | null
	connectionType: IslandRouterWanConnectionType
	role: IslandRouterWanRole
	failoverPriority: number | null
	linkState: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterWanConfig = {
	wans: Array<IslandRouterWanInterfaceConfig>
}

export type IslandRouterFailoverHealthCheck = {
	interfaceName: string | null
	ispName: string | null
	state: string | null
	role: IslandRouterWanRole
	failoverPriority: number | null
	monitor: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterFailoverStatus = {
	activeInterfaceName: string | null
	activeIspName: string | null
	policy: string | null
	healthChecks: Array<IslandRouterFailoverHealthCheck>
	rawOutput: string
}

export type IslandRouterRouteEntry = {
	destination: string | null
	gateway: string | null
	interfaceName: string | null
	protocol: string | null
	metric: number | null
	selected: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterRoutingTable = {
	routes: Array<IslandRouterRouteEntry>
}

export type IslandRouterNatRule = {
	ruleId: string | null
	type: string | null
	protocol: string | null
	interfaceName: string | null
	externalAddress: string | null
	externalPort: string | null
	internalAddress: string | null
	internalPort: string | null
	enabled: boolean | null
	description: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterNatRules = {
	rules: Array<IslandRouterNatRule>
}

export type IslandRouterVlanConfigEntry = {
	vlanId: number | null
	name: string | null
	interfaceName: string | null
	memberInterfaces: Array<string>
	status: string | null
	ipAddress: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterVlanConfig = {
	vlans: Array<IslandRouterVlanConfigEntry>
}

export type IslandRouterDnsServer = {
	address: string | null
	role: string | null
	source: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterDnsOverride = {
	host: string | null
	recordType: string | null
	value: string | null
	enabled: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterDnsConfig = {
	mode: string | null
	searchDomains: Array<string>
	servers: Array<IslandRouterDnsServer>
	overrides: Array<IslandRouterDnsOverride>
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterUserEntry = {
	username: string | null
	groupName: string | null
	role: string | null
	connectionType: string | null
	address: string | null
	connected: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterUsers = {
	users: Array<IslandRouterUserEntry>
	rawOutput: string
}

export type IslandRouterSecurityPolicyRule = {
	ruleId: string | null
	name: string | null
	action: string | null
	source: string | null
	destination: string | null
	service: string | null
	enabled: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterSecurityPolicy = {
	rules: Array<IslandRouterSecurityPolicyRule>
	rawOutput: string
}

export type IslandRouterQosPolicyEntry = {
	policyName: string | null
	interfaceName: string | null
	className: string | null
	priority: string | null
	bandwidth: string | null
	enabled: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterQosConfig = {
	policies: Array<IslandRouterQosPolicyEntry>
	rawOutput: string
}

export type IslandRouterTrafficStat = {
	interfaceName: string | null
	rxBytes: number | null
	txBytes: number | null
	rxPackets: number | null
	txPackets: number | null
	rxErrors: number | null
	txErrors: number | null
	utilizationPercent: number | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterTrafficStats = {
	interfaces: Array<IslandRouterTrafficStat>
}

export type IslandRouterActiveSession = {
	protocol: string | null
	sourceAddress: string | null
	sourcePort: number | null
	destinationAddress: string | null
	destinationPort: number | null
	translatedAddress: string | null
	translatedPort: number | null
	state: string | null
	interfaceName: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterActiveSessions = {
	sessions: Array<IslandRouterActiveSession>
}

export type IslandRouterVpnTunnel = {
	tunnelName: string | null
	type: string | null
	localEndpoint: string | null
	remoteEndpoint: string | null
	status: string | null
	interfaceName: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterVpnConfig = {
	tunnels: Array<IslandRouterVpnTunnel>
	rawOutput: string
}

export type IslandRouterDhcpServerPool = {
	poolName: string | null
	interfaceName: string | null
	network: string | null
	rangeStart: string | null
	rangeEnd: string | null
	gateway: string | null
	dnsServers: Array<string>
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterDhcpServerOption = {
	poolName: string | null
	option: string | null
	value: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterDhcpServerConfig = {
	pools: Array<IslandRouterDhcpServerPool>
	options: Array<IslandRouterDhcpServerOption>
	reservations: Array<IslandRouterDhcpLease>
	rawOutput: string
}

export type IslandRouterNtpServer = {
	server: string | null
	status: string | null
	source: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterNtpConfig = {
	timezone: string | null
	servers: Array<IslandRouterNtpServer>
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterSyslogTarget = {
	host: string | null
	port: number | null
	protocol: string | null
	facility: string | null
	enabled: boolean | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterSyslogConfig = {
	targets: Array<IslandRouterSyslogTarget>
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterSnmpCommunity = {
	community: string | null
	access: string | null
	source: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterSnmpTrapTarget = {
	host: string | null
	version: string | null
	community: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterSnmpConfig = {
	enabled: boolean | null
	communities: Array<IslandRouterSnmpCommunity>
	trapTargets: Array<IslandRouterSnmpTrapTarget>
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterSystemInfo = {
	uptime: string | null
	cpuUsagePercent: number | null
	memoryUsagePercent: number | null
	temperatureCelsius: number | null
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
}

export type IslandRouterBandwidthUsageEntry = {
	subject: string | null
	interfaceName: string | null
	rxRate: string | null
	txRate: string | null
	totalRate: string | null
	rawLine: string
	fields: Record<string, string>
}

export type IslandRouterBandwidthUsage = {
	entries: Array<IslandRouterBandwidthUsageEntry>
	rawOutput: string
}

export type IslandRouterReadCommandResult = {
	command: IslandRouterReadCommand
	commandId: Extract<
		IslandRouterCommandId,
		| 'show-ip-neighbors'
		| 'show-ip-sockets'
		| 'show-stats'
		| 'show-interface'
		| 'show-ip-interface'
		| 'show-log'
		| 'show-running-config'
		| 'show-running-config-differences'
		| 'show-ip-dhcp'
		| 'show-ip-routes'
		| 'show-ip-recommendations'
	>
	catalogEntry: IslandRouterReadCommandCatalogEntry
	commandLines: Array<string>
	rawOutput: string
	filteredOutput: string
	lines: Array<string>
	stdout: string
	stderr: string
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
	durationMs: number
}

export type IslandRouterStatus = {
	config: IslandRouterConfigStatus
	connected: boolean
	router: {
		version: IslandRouterVersionInfo | null
		clock: string | null
	}
	interfaces: Array<IslandRouterInterfaceSummary>
	neighbors: Array<IslandRouterNeighborEntry>
	errors: Array<string>
}
