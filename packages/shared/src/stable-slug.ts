import { fnv1a32Hex } from './fnv1a.ts'

/**
 * Slugify a free-form value, appending a stable FNV-1a hash suffix whenever
 * the slug is lossy so distinct inputs never collapse to the same slug.
 */
export function slugWithStableDisambiguator(input: {
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
	return `${slug}_${fnv1a32Hex(trimmed)}`
}
