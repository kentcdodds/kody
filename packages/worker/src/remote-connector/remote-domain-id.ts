import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { slugWithStableDisambiguator } from '@kody-internal/shared/stable-slug.ts'

export function remoteConnectorInstanceSlug(ref: RemoteConnectorRef): string {
	return slugWithStableDisambiguator({
		value: ref.instanceId,
		fallback: 'instance',
		allowedPattern: /^[\w-]+$/,
		replacementPattern: /[^\w-]+/g,
	})
}

export function remoteConnectorDomainId(ref: RemoteConnectorRef): string {
	return `remote:${remoteConnectorKodyName(ref)}`
}

export function remoteConnectorKodyName(ref: RemoteConnectorRef): string {
	return remoteConnectorInstanceSlug(ref)
}

export function remoteConnectorToolName(toolName: string): string {
	return slugWithStableDisambiguator({
		value: toolName,
		fallback: 'tool',
		allowedPattern: /^\w+$/,
		replacementPattern: /[^\w]+/g,
	})
}

export function remoteConnectorCapabilityId(input: {
	ref: RemoteConnectorRef
	toolName: string
}): string {
	return `remote:${remoteConnectorKodyName(input.ref)}:${remoteConnectorToolName(input.toolName)}`
}
