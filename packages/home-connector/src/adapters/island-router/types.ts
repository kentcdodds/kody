import {
	type IslandRouterCommandCatalogEntry,
	type IslandRouterCommandId,
	type IslandRouterCommandRiskLevel,
} from './command-catalog.ts'

export {
	islandRouterCommandCatalog,
	islandRouterCommandConfirmation,
	islandRouterCommandIds,
	type IslandRouterCommandCatalogEntry,
	type IslandRouterCommandId,
	type IslandRouterCommandRiskLevel,
} from './command-catalog.ts'

export type IslandRouterVerificationMode =
	| 'known-hosts'
	| 'fingerprint'
	| 'none'

export type IslandRouterConfigStatus = {
	configured: boolean
	missingFields: Array<string>
	verificationMode: IslandRouterVerificationMode
	warnings: Array<string>
	writeCapabilitiesAvailable: boolean
	writeWarnings: Array<string>
}

export type IslandRouterCommandRequest = {
	id: IslandRouterCommandId
	params?: Record<string, unknown>
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

export type IslandRouterRunCommandResult = {
	commandId: IslandRouterCommandId
	catalogEntry: IslandRouterCommandCatalogEntry
	params: Record<string, string>
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
