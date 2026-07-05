import { type ResolvedProvider } from '@cloudflare/codemode'

export type CodemodeRemoteCapabilityMetadata = {
	name: string
	dispatchName: string
}

export type CodemodeRemoteConnectorMetadata = {
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
	capabilities: Array<CodemodeRemoteCapabilityMetadata>
}

export type KodyResolvedProvider = ResolvedProvider & {
	kodyRemoteConnectors?: Array<CodemodeRemoteConnectorMetadata>
}
