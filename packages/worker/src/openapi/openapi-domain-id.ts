import { synthesizeDomainId } from '@kody-internal/shared/domain-id.ts'

export function openApiProviderKodyName(name: string): string {
	return synthesizeDomainId({
		namespace: 'openapi',
		value: name,
		fallback: 'provider',
	}).kodyName
}

export function openApiDomainId(name: string): string {
	return synthesizeDomainId({
		namespace: 'openapi',
		value: name,
		fallback: 'provider',
	}).domainId
}

export function openApiCapabilityId(name: string, slug: string): string {
	return `openapi:${openApiProviderKodyName(name)}:${slug}`
}
