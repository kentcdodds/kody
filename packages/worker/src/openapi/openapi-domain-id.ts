import { slugWithStableDisambiguator } from '@kody-internal/shared/stable-slug.ts'

export function openApiProviderKodyName(name: string): string {
	return slugWithStableDisambiguator({
		value: name,
		fallback: 'provider',
		allowedPattern: /^[\w-]+$/,
		replacementPattern: /[^\w-]+/g,
	})
}

export function openApiDomainId(name: string): string {
	return `openapi:${openApiProviderKodyName(name)}`
}

export function openApiCapabilityId(name: string, slug: string): string {
	return `openapi:${openApiProviderKodyName(name)}:${slug}`
}
