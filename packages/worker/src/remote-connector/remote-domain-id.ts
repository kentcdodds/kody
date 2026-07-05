import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'

export function remoteConnectorInstanceSlug(ref: RemoteConnectorRef): string {
	return (
		ref.instanceId
			.trim()
			.replaceAll(/[^\w-]+/g, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'instance'
	)
}

export function remoteConnectorDomainId(ref: RemoteConnectorRef): string {
	const k = ref.kind.trim().toLowerCase()
	return `remote:${k}:${remoteConnectorInstanceSlug(ref)}`
}

export function remoteConnectorCodemodeName(ref: RemoteConnectorRef): string {
	const k = ref.kind.trim().toLowerCase()
	return `${k}/${remoteConnectorInstanceSlug(ref)}`
}

export function remoteConnectorToolName(toolName: string): string {
	return (
		toolName
			.trim()
			.replaceAll(/[^\w]+/g, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'tool'
	)
}

export function remoteConnectorCapabilityId(input: {
	ref: RemoteConnectorRef
	toolName: string
}): string {
	return `remote:${remoteConnectorCodemodeName(input.ref)}:${remoteConnectorToolName(input.toolName)}`
}
