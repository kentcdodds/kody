import { type ResolvedProvider } from '@cloudflare/codemode'

export type KodyRemoteCapabilityMetadata = {
	name: string
	dispatchName: string
}

export type KodyRemoteConnectorMetadata = {
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
	capabilities: Array<KodyRemoteCapabilityMetadata>
}

export type KodyResolvedProvider = ResolvedProvider & {
	kodyRemoteConnectors?: Array<KodyRemoteConnectorMetadata>
}
