/** Canonical domain id values; descriptions live on each `DomainSpec` (see `coding/domain.ts`, etc.). */
export const capabilityDomainNames = {
	apps: 'apps',
	coding: 'coding',
	meta: 'meta',
} as const

export type CapabilityDomain =
	(typeof capabilityDomainNames)[keyof typeof capabilityDomainNames]
