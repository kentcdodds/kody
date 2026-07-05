import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'

function fnv1a32(input: string) {
	let hash = 2_166_136_261
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 16_777_619)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

function slugWithStableDisambiguator(input: {
	value: string
	fallback: string
	allowedPattern: RegExp
	replacementPattern: RegExp
}) {
	const trimmed = input.value.trim()
	const slug =
		trimmed
			.replaceAll(input.replacementPattern, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || input.fallback
	if (trimmed && input.allowedPattern.test(trimmed) && slug === trimmed) {
		return slug
	}
	return `${slug}_${fnv1a32(trimmed)}`
}

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
