import { type ResolvedProvider } from '@cloudflare/codemode'

export type CapabilitiesRemoteCapabilityMetadata = {
	name: string
	dispatchName: string
}

export type CapabilitiesRemoteConnectorMetadata = {
	name: string
	kind: string
	instanceId: string
	status: {
		state: string
		connected: boolean
		toolCount: number
		message: string
		unavailableMessage: string
	}
	capabilities: Array<CapabilitiesRemoteCapabilityMetadata>
}

export type CapabilitiesResolvedProvider = ResolvedProvider & {
	kodyRemoteConnectors?: Array<CapabilitiesRemoteConnectorMetadata>
}
