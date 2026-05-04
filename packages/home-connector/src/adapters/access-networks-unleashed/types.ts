export type AccessNetworksUnleashedDiscoveredController = {
	controllerId: string
	name: string
	host: string
	loginUrl: string
	lastSeenAt: string | null
	rawDiscovery: Record<string, unknown> | null
}

export type AccessNetworksUnleashedPersistedController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		username: string | null
		password: string | null
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedPublicController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		hasStoredCredentials: boolean
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedProbeDiagnostic = {
	host: string
	url: string
	matched: boolean
	status: number | null
	location: string | null
	matchReason: 'redirect' | 'login-page' | null
	error: string | null
	bodySnippet: string | null
}

export type AccessNetworksUnleashedSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	controllerMatches: number
}

export type AccessNetworksUnleashedDiscoveryDiagnostics = {
	protocol: 'subnet'
	discoveryUrl: string
	scannedAt: string
	probes: Array<AccessNetworksUnleashedProbeDiagnostic>
	subnetProbe: AccessNetworksUnleashedSubnetProbeSummary
}

export type AccessNetworksUnleashedDiscoveryResult = {
	controllers: Array<AccessNetworksUnleashedDiscoveredController>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics
}

export type AccessNetworksUnleashedConfigStatus = {
	configured: boolean
	adoptedControllerId: string | null
	host: string | null
	hasAdoptedController: boolean
	hasStoredCredentials: boolean
	allowInsecureTls: boolean
	missingRequirements: Array<'controller' | 'credentials'>
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type AccessNetworksUnleashedAjaxAction = 'getstat' | 'setconf' | 'docmd'

export type AccessNetworksUnleashedRequestInput = {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	xmlBody: string
	updater?: string
	allowInsecureTls?: boolean
}

export type AccessNetworksUnleashedRequestResult = {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	updater: string
	xml: string
	parsed: unknown
}

export type AccessNetworksUnleashedClient = {
	request(
		input: AccessNetworksUnleashedRequestInput,
	): Promise<AccessNetworksUnleashedRequestResult>
}
