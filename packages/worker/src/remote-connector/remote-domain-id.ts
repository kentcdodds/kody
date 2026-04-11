import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'

export function remoteConnectorDomainId(ref: RemoteConnectorRef): string {
	const k = ref.kind.trim().toLowerCase()
	const id =
		ref.instanceId
			.trim()
			.replaceAll(/[^\w-]+/g, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'instance'
	return `remote:${k}:${id}`
}

/**
 * Prefix for synthesized capability names. Keeps legacy `home_*` names when
 * there is a single home connector with instance id `default`.
 */
export function remoteConnectorCapabilityPrefix(
	ref: RemoteConnectorRef,
	allRefs: ReadonlyArray<RemoteConnectorRef>,
): string {
	const k = ref.kind.trim().toLowerCase()
	const rawId = ref.instanceId.trim()
	const slug =
		rawId
			.replaceAll(/[^\w]+/g, '_')
			.replaceAll(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'instance'

	if (k === 'home') {
		const isOnlyBuiltinHome =
			rawId === 'default' &&
			allRefs.length === 1 &&
			allRefs[0]?.kind.trim().toLowerCase() === 'home' &&
			allRefs[0]?.instanceId.trim() === 'default'
		if (isOnlyBuiltinHome) {
			return 'home'
		}
		return `home_${slug}`
	}

	return `${k}_${slug}`
}
