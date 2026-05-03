export type IslandRouterHostKind = 'ipv4' | 'ipv6' | 'mac' | 'hostname'

export type IslandRouterHostIdentity = {
	kind: IslandRouterHostKind
	value: string
	normalizedValue: string
}

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

export type IslandRouterCommandId =
	| 'show-version'
	| 'show-clock'
	| 'show-interface-summary'
	| 'show-interface'
	| 'show-ip-interface'
	| 'show-ip-neighbors'
	| 'show-ip-dhcp-reservations'
	| 'show-log'
	| 'ping'
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
			id: 'show-ip-neighbors'
			timeoutMs?: number
	  }
	| {
			id: 'show-ip-dhcp-reservations'
			timeoutMs?: number
	  }
	| {
			id: 'show-log'
			query?: string
			timeoutMs?: number
	  }
	| {
			id: 'ping'
			host: string
			timeoutMs?: number
			allowTimeout?: boolean
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

export type IslandRouterPingReply = {
	sequence: number | null
	timeMs: number | null
	rawLine: string
}

export type IslandRouterPingResult = {
	host: string
	addressFamily: 'auto' | 'ip' | 'ipv6'
	reachable: boolean | null
	timedOut: boolean
	completed: boolean
	transmitted: number | null
	received: number | null
	packetLossPercent: number | null
	replies: Array<IslandRouterPingReply>
	rawOutput: string
	stderr: string
}

export type IslandRouterVersionInfo = {
	model: string | null
	serialNumber: string | null
	firmwareVersion: string | null
	attributes: Array<IslandRouterKeyValue>
	rawOutput: string
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

export type IslandRouterHostDiagnosis = {
	host: IslandRouterHostIdentity
	ping: IslandRouterPingResult | null
	arpEntry: IslandRouterNeighborEntry | null
	dhcpLease: IslandRouterDhcpLease | null
	interfaceSummary: IslandRouterInterfaceSummary | null
	interfaceDetails: IslandRouterInterfaceDetails | null
	ipInterfaceDetails: IslandRouterInterfaceDetails | null
	recentEvents: Array<IslandRouterRecentEvent>
	errors: Array<string>
}
