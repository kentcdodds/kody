import { slugWithStableDisambiguator } from './stable-slug.ts'

export function synthesizeDomainId(input: {
	namespace: string
	value: string
	fallback: string
}): { domainId: string; kodyName: string } {
	const kodyName = slugWithStableDisambiguator({
		value: input.value,
		fallback: input.fallback,
		allowedPattern: /^[\w-]+$/,
		replacementPattern: /[^\w-]+/g,
	})
	return {
		domainId: `${input.namespace}:${kodyName}`,
		kodyName,
	}
}
