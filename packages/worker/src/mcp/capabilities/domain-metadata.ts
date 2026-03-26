/** Canonical domain id values; descriptions live on each `DomainSpec` (see `coding/domain.ts`, etc.). */
export const capabilityDomainNames = {
	apps: 'apps',
	coding: 'coding',
	home: 'home',
	math: 'math',
	meta: 'meta',
	secrets: 'secrets',
} as const

export type CapabilityDomain =
	(typeof capabilityDomainNames)[keyof typeof capabilityDomainNames]
